import { CHARACTER_SPRITE_CODES, Direction } from "../shared/constants.ts";
import { BinaryReader, decompressSmartStreamAsync } from "../shared/crypto.ts";
import { FftFont } from "../shared/formats/fft.ts";
import {
  type BikVideoHeader,
  type BomberCharacterAttr,
  type ItemAttrEntry,
  type MapGroupEntry,
  type ParsedGameMap,
  type ShipAttr,
  parseBikHeader,
  parseBomberAttr,
  parseGameMap,
  parseItemAttr,
  parseStringTableBuffer,
} from "../shared/formats/gameData.ts";
import {
  type DecodedI16,
  type I16FrameMeta,
  decodeI16,
  tintI16LayerAdjust,
} from "../shared/formats/i16.ts";
import {
  type ObjectStateAnim,
  type ObjectTemplateEntry,
  type TileInfoDesc,
  parseObjectTable,
  parseTileInfoList,
} from "../shared/formats/objectTable.ts";
import {
  type ArchiveName,
  type ParsedPackIndex,
  lookupPackEntry,
  parsePackIdx,
} from "../shared/formats/packIndex.ts";
import { type EquippedAvatar, type ShopItemDTO } from "../shared/protocol.ts";
import { BomberStatus, type StaticMapData } from "../shared/sim/world.ts";
import type { GpuTextureHandle, RGBA, WebGpuRenderer } from "./gpu/renderer.ts";

export interface GpuSpriteSheet {
  frames: I16FrameMeta[];
  textures: GpuTextureHandle[];
}

export class ClientAssetManager {
  public readonly renderer: WebGpuRenderer;

  public readonly packIdx = new Map<ArchiveName, ParsedPackIndex>();
  public fxTemplates: ObjectTemplateEntry[] = [];
  public fxByName = new Map<string, ObjectTemplateEntry>();
  public charTemplates: ObjectTemplateEntry[] = [];
  public charByName = new Map<string, ObjectTemplateEntry>();
  public emoTemplates: ObjectTemplateEntry[] = [];
  public emoByName = new Map<string, ObjectTemplateEntry>();

  /**
   * The authentic Taiwanese UI strings from csysstr.ssd (5336 entries), e.g.
   * StateLose="敗北", StateLocked="咕嚕嚕", StateWin="勝利". Loaded from
   * /api/raw/csysstr.ssd so no hand-written English ever reaches the HUD.
   */
  public sysStrings = new Map<string, string>();

  public bombers: BomberCharacterAttr[] = [];
  public ships: ShipAttr[] = [];
  public itemsByName = new Map<string, ItemAttrEntry>();
  public mapGroups: MapGroupEntry[] = [];
  public mapNames: string[] = [];
  public readonly mapCache = new Map<string, ParsedGameMap>();
  public tileInfos = new Map<string, TileInfoDesc>();
  public shopCatalog: ShopItemDTO[] = [];
  public shopById = new Map<number, ShopItemDTO>();
  public bikHeader: BikVideoHeader | null = null;

  private readonly rawEntryCache = new Map<string, Uint8Array>();
  private readonly decodedBaseCache = new Map<string, DecodedI16>();
  private readonly spriteCache = new Map<string, GpuSpriteSheet>();
  private readonly jpegCache = new Map<string, GpuTextureHandle>();
  private readonly inflightEntries = new Map<string, Promise<Uint8Array | null>>();
  private readonly inflightJpegs = new Map<string, Promise<GpuTextureHandle | null>>();

  constructor(renderer: WebGpuRenderer) {
    this.renderer = renderer;
  }

  public get staticMapData(): StaticMapData {
    return {
      bombers: this.bombers,
      items: this.itemsByName,
      ships: this.ships,
      fxTemplates: this.fxTemplates,
      tileInfos: this.tileInfos,
    };
  }

  public async initCore(onProgress?: (label: string, pct: number) => void): Promise<void> {
    onProgress?.("正在載入字型 (CxUni.fft)...", 10);
    void this.loadSystemStrings();
    const [uniRes, boldRes, bootRes] = await Promise.all([
      fetch("/api/raw/CxUni.fft"),
      fetch("/api/raw/CxUniBold.fft"),
      fetch("/api/bootstrap"),
    ]);

    const uniBytes = new Uint8Array(await uniRes.arrayBuffer());
    const boldBytes = boldRes.ok ? new Uint8Array(await boldRes.arrayBuffer()) : uniBytes;
    this.renderer.setFonts(
      new FftFont("CxUni", uniBytes),
      new FftFont("CxUniBold", boldBytes),
    );

    const boot = (await bootRes.json()) as {
      mapNames: string[];
      mapGroups: MapGroupEntry[];
      bombers: BomberCharacterAttr[];
      ships: ShipAttr[];
      shopCatalog: ShopItemDTO[];
    };
    this.mapNames = boot.mapNames;
    this.mapGroups = boot.mapGroups;
    this.bombers = boot.bombers;
    this.ships = boot.ships;
    this.shopCatalog = boot.shopCatalog;
    for (const s of boot.shopCatalog) {
      this.shopById.set(s.itemId, s);
    }

    onProgress?.("正在解密索引檔 (Fx.idx / CharTE.idx / EmoTE.idx)...", 35);
    const archives: ArchiveName[] = ["Fx", "CharTE", "EmoTE"];
    await Promise.all(
      archives.map(async (arc) => {
        const r = await fetch(`/api/pack/${arc}/idx`);
        const buf = new Uint8Array(await r.arrayBuffer());
        this.packIdx.set(arc, parsePackIdx(buf, arc));
      }),
    );

    onProgress?.("正在載入物件樣板庫與原版介面圖層...", 65);
    await this.prefetchBatch("Fx", [
      "ObjectTable/ObjectTable",
      "TileInfo/TileInfoList",
      "Attr/ItemAttr",
      "Attr/BomberAttr",
      "Shadow/Shadow",
      "Bomb/Bomb00",
      "Bomb/BombRadio",
      "Bomb/Bubble00",
      "Bomb/Fire00",
      "Game/CaptainFlag",
      "Game/BtExit",
      "Game/Timer",
      "Game/ItemBox00",
      "Game/ItemBox01",
      "Game/ItemCount",
      "Game/SelfIndicator",
      "Game/Start",
      "Game/Win",
      "Game/Lose",
      "Game/Draw",
      "Game/HurryUp",
      "Game/ResultInfoBar",
      "Game/PatResultDlg",
      "AIaider/RedZone",
      // GlobalUI bottom bar
      "GlobalUI/Dlg_Back",
      "GlobalUI/BtMenu",
      "GlobalUI/BtBack",
      "GlobalUI/BtShop",
      "GlobalUI/BtMyitem",
      "GlobalUI/BtMyInfo",
      "GlobalUI/BtMessenger",
      "GlobalUI/BtUserMarket",
      "GlobalUI/Bt_IconHelp",
      "GlobalUI/BtBasket",
      "GlobalUI/BtEvent",
      "GlobalUI/BtExit",
      "GlobalUI/MenuDlg_Back",
      // LoginStage
      "LoginStage/LO_LogTable00",
      "LoginStage/LO_LogTable01",
      "LoginStage/LO_Bt1P",
      "LoginStage/LO_Bt2P",
      "LoginStage/LO_BtLogNewId",
      "LoginStage/LO_BtLogOk",
      "LoginStage/LO_BtLogExit",
      "LoginStage/LO_BTLogCred",
      "LoginStage/Dlg_LO-NewID",
      "LoginStage/LO_BtAgree",
      "LoginStage/LO_BtOppo",
      // SelectServerStage
      "SelectServerStage/CH_Bt_Channel",
      "SelectServerStage/CH_Bar_User",
      "SelectServerStage/CH_Bt_ChNum",
      "SelectServerStage/CH_Bt_Left",
      "SelectServerStage/CH_Bt_Right",
      "SelectServerStage/CH_ChBar_Novice",
      "SelectServerStage/CH_ChBar_Free",
      "SelectServerStage/CH_ChBar_Ladder",
      "SelectServerStage/CH_ChBar_Special",
      "SelectServerStage/CH_ChBar_Event",
      "SelectServerStage/CH_Tab_Novice",
      "SelectServerStage/CH_Tab_Free",
      "SelectServerStage/CH_Tab_Ladder",
      "SelectServerStage/CH_Tab_Special",
      "SelectServerStage/CH_Tab_Event",
      // Lobby
      "Lobby/LB_Bt_SessionSlot",
      "Lobby/LB_Bt_RoomInfo",
      "Lobby/LB_Bt_T_QuickJoin-NM",
      "Lobby/LB_Bt_T_Create-MM",
      "Lobby/LB_Bt_T_QuickJoin-MM",
      "Lobby/LB_Bt_T_WaitRoom",
      "Lobby/LB_Bt_T_ShowAll",
      "Lobby/LB_Bt_T_Practice",
      "Lobby/LB_Bt_T_WaitRoom-MM",
      "Lobby/LB_Bt_T_ShowAll-MM",
      "Lobby/LB_Bt_T_Practice-MM",
      "Lobby/LB_Bt_Left01",
      "Lobby/LB_Bt_Right01",
      "Lobby/LB_Bt_Left02",
      "Lobby/LB_Bt_Right02",
      "Lobby/LB_Img",
      "Lobby/Dlg_LB-Create",
      "Lobby/Dlg_LB-Practice",
      // Prepare
      "Prepare/PRE_Bt_Slot-Open",
      "Prepare/PRE_Bt_Slot-Close",
      "Prepare/PRE_Bt_Start",
      "Prepare/PRE_Bt_Ready",
      "Prepare/PRE_Bt_Selectmap",
      "Prepare/PRE_Bt_Roominfo",
      "Prepare/PRE_Bt_CheckBox",
      "Prepare/PRE_SelChara",
      "Prepare/PRE_Ability",
      "Prepare/PRE_Img",
      "Prepare/Dlg_PRE-SelMap",
      "Prepare/Dlg_PRE-SelMapBt_ListAll",
      "Prepare/Dlg_PRE-SelMapBt_ListAvailable",
      "Prepare/PRE_SelTeam-Basic00",
      "Prepare/PRE_SelTeam-Basic01",
      "Prepare/PRE_SelTeam-Basic02",
      "Prepare/PRE_SelTeam-Basic03",
      "Prepare/PRE_SelTeam-Basic04",
      "Prepare/PRE_SelTeam-Basic05",
      "Prepare/PRE_SelTeam-Basic06",
      "Prepare/PRE_SelTeam-Basic07",
      // Etc shared controls
      "Etc/SelChara00",
      "Etc/SelChara01",
      "Etc/SelChara02",
      "Etc/SelChara03",
      "Etc/SelChara04",
      "Etc/SelChara05",
      "Etc/SelChara06",
      "Etc/SelChara07",
      "Etc/SelChara10",
      "Etc/Room_Num",
      "Etc/BtOk",
      "Etc/BtCancel",
      "Etc/BtClose",
      "Etc/BtYes",
      "Etc/BtNo",
      "Etc/BtSpeaker_Speaker",
      // Game HUD, Portraits & Shadow
      "Shadow/Shadow",
      "Game/Timer",
      "Game/ItemBox00",
      "Game/ItemBox01",
      "Game/ItemCount",
      "Game/BtExit",
      "Game/Start",
      "Game/Win",
      "Game/Lose",
      "Game/Draw",
      "Game/HurryUp",
      "Game/ResultInfoBar",
      "Game/SelfIndicator",
      // Portrait layers as they really exist in Fx.idd -- not every character has
      // an A-layer "Adjust" half, and C02/C06/C10/C11 add an extra C layer.
      "Character/C00-Portrait_ALayerAdjust",
      "Character/C00-Portrait_ALayerStatic",
      "Character/C01-Portrait_ALayerAdjust",
      "Character/C01-Portrait_ALayerStatic",
      "Character/C02-Portrait_ALayerStatic",
      "Character/C02-Portrait_CLayerAdjust",
      "Character/C02-Portrait_CLayerStatic",
      "Character/C03-Portrait_ALayerAdjust",
      "Character/C03-Portrait_ALayerStatic",
      "Character/C04-Portrait_ALayerAdjust",
      "Character/C04-Portrait_ALayerStatic",
      "Character/C05-Portrait_ALayerAdjust",
      "Character/C05-Portrait_ALayerStatic",
      "Character/C06-Portrait_ALayerAdjust",
      "Character/C06-Portrait_ALayerStatic",
      "Character/C06-Portrait_CLayerAdjust",
      "Character/C07-Portrait_ALayerAdjust",
      "Character/C07-Portrait_ALayerStatic",
      "Character/C08-Portrait_ALayerAdjust",
      "Character/C08-Portrait_ALayerStatic",
      "Character/C09-Portrait_ALayerAdjust",
      "Character/C09-Portrait_ALayerStatic",
      "Character/C10-Portrait_ALayerStatic",
      "Character/C10-Portrait_CLayerStatic",
      // Shop, Gachapon, Gift, MyInfo, Market, Exchange, Messenger, Tutorial, Credit & Common UI
      "Etc/Cursor",
      "Etc/TextBox",
      "Etc/ChatBalloon",
      "Etc/Dlg_Notice",
      "Etc/StageOpacity",
      "Etc/Dlg_Option",
      "Etc/BtCheckBox",
      "Etc/VScroll_BtUp",
      "Etc/VScroll_BtDown",
      "Etc/VScroll_Ball",
      "Etc/LevelIcons",
      "Etc/PageNum",
      "Etc/Dlg_CreateBt_Default",
      "Etc/Dlg_CreateBt_Rehab",
      "Etc/Dlg_CreateBt_hedgehog",
      "Etc/Dlg_CreateBt_Timebomb",
      "Etc/Dlg_CreateBt_Flag",
      "Etc/Dlg_Create_DefaultImg",
      "Etc/Dlg_Create_RehabImg",
      "Etc/Dlg_Create_hedgehogImg",
      "Etc/Dlg_Create_TimebombImg",
      "Etc/Dlg_Create_FlagImg",
      "Etc/Dlg_Create_Check",
      "GlobalUI/Glob_ToolTip",
      "GlobalUI/MenuIcon",
      "GlobalUI/MenuDlg_Back01",
      "GlobalUI/MenuDlg_Back02",
      "GlobalUI/MenuDlg_Back03",
      "GlobalUI/MenuDlg_Back04",
      "GlobalUI/MenuDlg_Back05",
      "GlobalUI/MenuDlg_Back06",
      "LoginStage/LO_Bt_IDCheck",
      "Lobby/Dlg_LB-NMCreate",
      "PraticePrepare/Lev_Bt-Down",
      "PraticePrepare/Lev_Bt-Up",
      "PraticePrepare/Practice_Title",
      "Prepare/Dlg_PRE-Roominfo",
      "Prepare/Dlg_PRE-OverMapBar",
      "Prepare/Dlg_PRE-SelMapListIcon",
      "Game/TeamColor",
      "Game/TimebombIndicator",
      "Game/ChatBalloon",
      "Game/Kill_Image",
      "Item/Shield",
      "Item/ShieldOn",
      "Item/ShieldFlash",
      "Item/Dart",
      "Item/Niddle",
      "Item/Spring",
      "Item/RadioBomb",
      "Shop/S_BtItemSlot03",
      "Shop/S_MoneyCount",
      "Shop/S_ScrNum",
      "Shop/S_TabSet",
      "Shop/S_TabChar",
      "Shop/S_TabItem",
      "Shop/S_TabSpecial",
      "Shop/S_TabSlot",
      "Shop/S_BtPBuy",
      "Shop/S_BtPSendGift",
      "Shop/S_BtScrLeft",
      "Shop/S_BtScrRight",
      "Shop/S_BtUndo",
      "Shop/S_BtLucky",
      "Shop/S_BackLight",
      "Shop/S_DlgLot01",
      "Shop/S_LotCard01",
      "Shop/S_DlgSendGift",
      "MyInfo/MP_Stage",
      "MyInfo/MP_Tab_MyInfo",
      "MyInfo/MP_Tab_MyItem",
      "MyInfo/MP_Tab_Quest",
      "MyInfo/MP_BtExit",
      "MyInfo/MP_ItemBag",
      "MyInfo/MP_BtItemBack00",
      "MyInfo/MP_BtItemBagLeft",
      "MyInfo/MP_BtItemBagRight",
      "MyInfo/MP_BackProfile",
      "MyInfo/MP_BackInfoRecord",
      "MyInfo/MP_BtSelChaDown",
      "MyInfo/MP_BtSexCheckBox",
      "UserMarket/UM_TabMain",
      "UserMarket/UM_TabMyItem",
      "UserMarket/UM_BtItemSlot01",
      "UserMarket/UM_BtBuy",
      "UserMarket/UM_BtItemRegistration",
      "UserMarket/UM_DlgSaleRegistration",
      "Exchange/Ex_BtConfirm",
      "Exchange/Ex_BtCancel",
      "Exchange/Ex_MoneyCount",
      "NM/Dlg_NM-ListGlobal",
      "NM/Dlg_NM-ListGlobalImg",
      "NM/Dlg_NM-ListBt_Close",
      "NM/Dlg_NM-ListBt_Exit",
      "NM/Dlg_NM-ListBt_Mail",
      "NM/Dlg_NM-ListBt_Option",
      "NM/Dlg_NM-ListBt_UserInfo",
      "NM/Dlg_NM-MsgGlobal",
      "NM/Dlg_NM-MsgBt_ReceiveTab",
      "NM/Dlg_NM-MsgBt_SendTab",
      "NM/Dlg_NM-MsgBt_MsgSelBar",
      "NM/Dlg_NM-MsgIcon",
      "NM/Dlg_NM-MsgBt_Send",
      "NM/Dlg_NM-MsgBt_Del",
      "Tutorial/Tutorialback",
      "Tutorial/01",
      "Tutorial/back-button",
      "Tutorial/front-button",
      "Tutorial/end-button",
      "StageCredit/Credit",
      "StageCredit/CreditImg",
      "StageCredit/BtREW",
      "StageCredit/BtPlay",
      "StageCredit/BtPause",
      "StageCredit/BtFF",
      "StageCredit/BtExit",
      "GlobalUI/MenuDlg_Back00",
      "GlobalUI/MenuDlg_Back_2",
      "Shop/EmotSmile",
      "Shop/EmotAngry",
      "Shop/EmotSad",
      "Shop/EmotLove",
      "Shop/EmotGreet",
      "Shop/EmotShy",
      "Shop/EmotDance",
      "Shop/EmotSpecial",
      "Shop/S_BtPSendGift",
      "Shop/S_BtLotBuy",
      "UserMarket/UM_BtLucciMax",
      "Exchange/Ex_MoneyCount",
      "MyInfo/MP_BtSelChaDown",
      "Tutorial/next-button",
      "Shop/S_BtItemSlot01",
      "Lobby/LB_Bt_T_Create-NM",
      "NM/Dlg_NM-ListIcon_Logon",
      "NM/Dlg_NM-ListIcon_Logout",
      "NM/Dlg_NM-MsgBt_DelAll",
    ]);

    const fxOTBytes = this.rawEntryCache.get("Fx:objecttable/objecttable")!;
    const fxOT = parseObjectTable(fxOTBytes, 0);
    this.fxTemplates = fxOT.entries;
    this.fxByName = fxOT.byName;

    const tiBytes = this.rawEntryCache.get("Fx:tileinfo/tileinfolist")!;
    this.tileInfos = parseTileInfoList(tiBytes);

    const iaBytes = this.rawEntryCache.get("Fx:attr/itemattr")!;
    const itemAttr = parseItemAttr(iaBytes);
    for (const it of itemAttr.items) {
      this.itemsByName.set(it.name, it);
      this.itemsByName.set(it.name.toLowerCase(), it);
    }
    const baBytes = this.rawEntryCache.get("Fx:attr/bomberattr");
    if (baBytes) {
      this.bombers = parseBomberAttr(baBytes);
    }

    // Load CharTE & EmoTE ObjectTables
    const charIdx = this.packIdx.get("CharTE")!;
    const charOTKey = [...charIdx.entries.values()].find((m) =>
      m.name.toLowerCase().includes("objecttable"),
    )?.name;
    if (charOTKey) {
      const b = await this.fetchEntry("CharTE", charOTKey);
      if (b) {
        const ot = parseObjectTable(b, this.fxTemplates.length);
        this.charTemplates = ot.entries;
        this.charByName = ot.byName;
      }
    }

    const emoIdx = this.packIdx.get("EmoTE")!;
    const emoOTKey = [...emoIdx.entries.values()].find((m) =>
      m.name.toLowerCase().includes("objecttable"),
    )?.name;
    if (emoOTKey) {
      const b = await this.fetchEntry("EmoTE", emoOTKey);
      if (b) {
        const ot = parseObjectTable(b, this.fxTemplates.length + this.charTemplates.length);
        this.emoTemplates = ot.entries;
        this.emoByName = ot.byName;
      }
    }

    // Parse nm.bik header (first 512 bytes or full file)
    try {
      const bikRes = await fetch("/api/raw/nm.bik");
      if (bikRes.ok) {
        const bikBytes = new Uint8Array(await bikRes.arrayBuffer());
        this.bikHeader = parseBikHeader(bikBytes);
      }
    } catch {
      // optional
    }

    onProgress?.("正在預載舞台背景與角色圖層...", 90);
    await Promise.all([
      this.getJpegTexture("Fx", "LoginStage/CAStage"),
      this.getJpegTexture("Fx", "SelectServerStage/CAStage"),
      this.getJpegTexture("Fx", "Lobby/CAStage"),
      this.getJpegTexture("Fx", "Prepare/CAStage"),
      this.getJpegTexture("Fx", "Game/CAStage"),
      this.getJpegTexture("Fx", "Shop/Stage"),
      this.getJpegTexture("Fx", "UserMarket/Stage"),
      this.getJpegTexture("Fx", "Exchange/CAStage"),
      this.getJpegTexture("Fx", "Chatting/CAStage"),
      this.getJpegTexture("Fx", "StageCredit/CAStage"),
      this.getJpegTexture("Fx", "Prepare/CAStageMonster"),
      this.prefetchCharacterBase(0),
      this.prefetchCharacterBase(5),
    ]);
    onProgress?.("載入完成！", 100);
  }

  private cacheKey(archive: ArchiveName, path: string): string {
    return `${archive}:${path.replace(/\\/g, "/").toLowerCase()}`;
  }

  public hasEntryInPack(archive: ArchiveName, path: string): boolean {
    const idx = this.packIdx.get(archive);
    return idx ? !!lookupPackEntry(idx, path) : false;
  }

  public getRawEntrySync(archive: ArchiveName, path: string): Uint8Array | null {
    const key = this.cacheKey(archive, path);
    const cached = this.rawEntryCache.get(key);
    if (cached) return cached;
    void this.fetchEntry(archive, path);
    return null;
  }

  public async fetchEntry(archive: ArchiveName, path: string): Promise<Uint8Array | null> {
    const key = this.cacheKey(archive, path);
    const cached = this.rawEntryCache.get(key);
    if (cached) return cached;

    if (!this.hasEntryInPack(archive, path)) return null;

    const existing = this.inflightEntries.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const res = await fetch(
          `/api/pack/${archive}/entry?path=${encodeURIComponent(path)}`,
        );
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        this.rawEntryCache.set(key, bytes);
        return bytes;
      } catch {
        return null;
      } finally {
        this.inflightEntries.delete(key);
      }
    })();

    this.inflightEntries.set(key, p);
    return p;
  }

  public async prefetchBatch(archive: ArchiveName, paths: string[]): Promise<void> {
    const missing = paths.filter((p) => {
      const k = this.cacheKey(archive, p);
      return !this.rawEntryCache.has(k) && this.hasEntryInPack(archive, p);
    });
    if (missing.length === 0) return;

    // Split in chunks of 180
    for (let i = 0; i < missing.length; i += 180) {
      const slice = missing.slice(i, i + 180);
      try {
        const res = await fetch(`/api/pack/${archive}/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: slice }),
        });
        if (!res.ok) continue;
        const buf = new Uint8Array(await res.arrayBuffer());
        const r = new BinaryReader(buf);
        const count = r.u32();
        for (let j = 0; j < count; j++) {
          const p = r.str16UTF8();
          const len = r.u32();
          const data = buf.slice(r.offset, r.offset + len);
          r.skip(len);
          this.rawEntryCache.set(this.cacheKey(archive, p), data);
        }
      } catch {
        // ignore network hiccup
      }
    }
  }

  public getJpegSync(archive: ArchiveName, path: string): GpuTextureHandle | null {
    const key = this.cacheKey(archive, path);
    const hit = this.jpegCache.get(key);
    if (hit) return hit;

    if (!this.inflightJpegs.has(key)) {
      void this.getJpegTexture(archive, path);
    }
    return null;
  }

  public async getJpegTexture(archive: ArchiveName, path: string): Promise<GpuTextureHandle | null> {
    const key = this.cacheKey(archive, path);
    const hit = this.jpegCache.get(key);
    if (hit) return hit;

    const inflight = this.inflightJpegs.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      const bytes = await this.fetchEntry(archive, path);
      if (!bytes || bytes.byteLength < 4) return null;
      const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
      try {
        const tex = await this.renderer.createTextureFromImageBytes(bytes, mime);
        this.jpegCache.set(key, tex);
        return tex;
      } catch {
        return null;
      } finally {
        this.inflightJpegs.delete(key);
      }
    })();

    this.inflightJpegs.set(key, task);
    return task;
  }

  public getSpriteSync(
    archive: ArchiveName,
    path: string,
    teamTint = -1,
  ): GpuSpriteSheet | null {
    const baseKey = this.cacheKey(archive, path);
    const gpuKey = teamTint >= 0 ? `${baseKey}#t${teamTint}` : baseKey;
    const hit = this.spriteCache.get(gpuKey);
    if (hit) return hit;

    const raw = this.rawEntryCache.get(baseKey);
    if (!raw) {
      void this.fetchEntry(archive, path);
      return null;
    }

    // Ignore JPEGs accidentally queried as .i16
    if (raw[0] === 0xff && raw[1] === 0xd8) return null;

    let decoded = this.decodedBaseCache.get(baseKey);
    if (!decoded) {
      try {
        const mode = path.toLowerCase().includes("shadow") ? "shadow" : "normal";
        decoded = decodeI16(raw, mode);
        this.decodedBaseCache.set(baseKey, decoded);
      } catch {
        return null;
      }
    }

    const effective =
      teamTint >= 0 ? tintI16LayerAdjust(decoded, teamTint) : decoded;
    const textures = effective.textures.map((t) =>
      this.renderer.createTextureFromRGBA(t.width, t.height, t.rgba),
    );
    const sheet: GpuSpriteSheet = {
      frames: effective.frames,
      textures,
    };
    this.spriteCache.set(gpuKey, sheet);
    return sheet;
  }

  public drawSpriteFrame(
    sheet: GpuSpriteSheet,
    frameIdx: number,
    anchorX: number,
    anchorY: number,
    color: RGBA = [1, 1, 1, 1],
    scale = 1,
    additive = false,
  ): boolean {
    if (sheet.frames.length === 0) return false;
    const f = sheet.frames[Math.max(0, Math.min(sheet.frames.length - 1, frameIdx))]!;
    const tex = sheet.textures[f.texIndex];
    if (!tex || f.width <= 0 || f.height <= 0) return false;

    const x = anchorX - f.pivotX * scale;
    const y = anchorY - f.pivotY * scale;
    const u0 = f.left / tex.width;
    const v0 = f.top / tex.height;
    const u1 = f.right / tex.width;
    const v1 = f.bottom / tex.height;

    this.renderer.drawQuad(
      tex,
      x,
      y,
      f.width * scale,
      f.height * scale,
      u0,
      v0,
      u1,
      v1,
      color,
      additive,
    );
    return true;
  }

  public resolveAnimFrameIndex(state: ObjectStateAnim, tick: number): number {
    if (state.frames.length === 0) return 0;
    if (state.frames.length === 1 || state.totalTicks <= 0) {
      return state.frames[0]!.frameIndex;
    }
    let t = ((tick % state.totalTicks) + state.totalTicks) % state.totalTicks;
    for (const f of state.frames) {
      const delay = Math.max(1, f.delayTicks);
      if (t < delay) return f.frameIndex;
      t -= delay;
    }
    return state.frames[state.frames.length - 1]!.frameIndex;
  }

  /** Loads csysstr.ssd (CA.exe's own UI string table) so HUD labels are authentic. */
  public async loadSystemStrings(): Promise<void> {
    try {
      const res = await fetch("/api/raw/csysstr.ssd");
      if (!res.ok) return;
      const raw = new Uint8Array(await res.arrayBuffer());
      const table = parseStringTableBuffer(await decompressSmartStreamAsync(raw));
      for (const [k, v] of table) this.sysStrings.set(k, v);
    } catch {
      // Offline / not ready -- callers fall back to a sensible label.
    }
  }

  /** Looks up an authentic CA.exe UI string, falling back to `fallback`. */
  public sysStr(key: string, fallback: string): string {
    const v = this.sysStrings.get(key);
    return v && v.length > 0 ? v : fallback;
  }

  public drawFxTemplateState(
    tpl: ObjectTemplateEntry,
    stateMatch: string | number,
    tick: number,
    anchorX: number,
    anchorY: number,
    color: RGBA = [1, 1, 1, 1],
    scale = 1,
  ): boolean {
    if (tpl.states.length === 0) return false;
    let st: ObjectStateAnim | undefined;
    if (typeof stateMatch === "number") {
      st = tpl.states[Math.max(0, Math.min(tpl.states.length - 1, stateMatch))];
    } else {
      const lower = stateMatch.toLowerCase();
      st =
        tpl.states.find((s) => s.stateName.toLowerCase() === lower) ??
        tpl.states.find((s) => s.stateName.toLowerCase().includes(lower)) ??
        tpl.states[tpl.states.length - 1];
    }
    if (!st) return false;

    const frameIdx = this.resolveAnimFrameIndex(st, tick);
    const sheet = this.getSpriteSync("Fx", st.imagePath);
    if (!sheet) return false;
    return this.drawSpriteFrame(sheet, frameIdx, anchorX, anchorY, color, scale);
  }

  public async prefetchMapAssets(mapName: string): Promise<ParsedGameMap | null> {
    const cached = this.mapCache.get(mapName.toLowerCase());
    if (cached) return cached;
    const rawMap = await this.fetchEntry("Fx", `Map/${mapName}`);
    if (!rawMap) return null;
    const parsed = parseGameMap(mapName, rawMap);
    this.mapCache.set(mapName.toLowerCase(), parsed);

    const needed = new Set<string>();
    const addTpl = (id: number) => {
      if (id < 0) return;
      const tpl = this.fxTemplates[id];
      if (!tpl) return;
      for (const st of tpl.states) {
        if (st.imagePath) needed.add(st.imagePath);
      }
    };

    for (let i = 0; i < parsed.groundIds.length; i++) addTpl(parsed.groundIds[i]!);
    for (let i = 0; i < parsed.objectIds.length; i++) addTpl(parsed.objectIds[i]!);

    // Also prefetch common items & ships
    // Real Fx.idd sprite paths (NOT ObjectTable template aliases!)
    const commonSprites = [
      "Item/Bomb",
      "Item/Fire",
      "Item/Roller",
      "Item/Shoe",
      "Item/Punch",
      "Item/MaxPower",
      "Item/Potion",
      "Item/RedDevil",
      "Item/Niddle",
      "Item/Dart",
      "Item/ThrownDart",
      "Item/Spring",
      "Item/Shield",
      "Item/ShieldOn",
      "Item/ShieldFlash",
      "Item/Owl",
      "Item/Turtle0",
      "Item/Turtle1",
      "Item/Airship",
      "Item/CoinBronze",
      "Item/CoinSilver",
      "Item/CoinGold",
      "Ship/Owl-Down",
      "Ship/Owl-Up",
      "Ship/Owl-Left",
      "Ship/Owl-Right",
      "Ship/Turtle0-Down",
      "Ship/Turtle0-Up",
      "Ship/Turtle0-Left",
      "Ship/Turtle0-Right",
      "Ship/Turtle1-Down",
      "Ship/Turtle1-Up",
      "Ship/Turtle1-Left",
      "Ship/Turtle1-Right",
      "Ship/Airship-Down",
      "Ship/Airship-Up",
      "Ship/Airship-Left",
      "Ship/Airship-Right",
      "Ship/Tank_down",
      "Ship/Tank_up",
      "Ship/Tank_left",
      "Ship/Tank_right",
      "Game/CAStage",
    ];
    for (const s of commonSprites) needed.add(s);
    for (const [, ia] of this.itemsByName) {
      const tpl = this.fxByName.get(ia.templateName.toLowerCase());
      if (tpl) {
        for (const st of tpl.states) if (st.imagePath) needed.add(st.imagePath);
      }
    }

    await this.prefetchBatch("Fx", [...needed]);
    await this.getJpegTexture("Fx", "Game/CAStage");
    return parsed;
  }

  public resolveCharacterSpriteCode(charIndex: number): string {
    const idx = Math.max(0, Math.min(10, charIndex === 8 ? 0 : charIndex));
    return CHARACTER_SPRITE_CODES[idx] ?? "C00";
  }

  public async prefetchCharacterBase(charIndex: number): Promise<void> {
    const code = this.resolveCharacterSpriteCode(charIndex);
    const tpl =
      this.fxByName.get(`character/${code.toLowerCase()}_a`) ??
      this.fxByName.get(`character/${code.toLowerCase()}`) ??
      this.fxByName.get("character/c00_a");
    if (!tpl) return;

    const paths = new Set<string>();
    for (const st of tpl.states) {
      if (!st.imagePath) continue;
      paths.add(st.imagePath);
      paths.add(`${st.imagePath}LayerAdjust`);
      paths.add(`${st.imagePath}LayerStatic`);
    }
    const disp = this.fxByName.get(`character/${code.toLowerCase()}_display_a`);
    if (disp) {
      for (const st of disp.states) {
        paths.add(`${st.imagePath}LayerAdjust`);
        paths.add(`${st.imagePath}LayerStatic`);
      }
    }
    const port = this.fxByName.get(`character/${code.toLowerCase()}_portrait_a`);
    if (port) {
      for (const st of port.states) {
        paths.add(`${st.imagePath}LayerAdjust`);
        paths.add(`${st.imagePath}LayerStatic`);
      }
    }
    await this.prefetchBatch("Fx", [...paths]);
  }

  /**
   * Draws the in-game HUD portrait. A portrait is built from up to three layers
   * (A/B/C); each layer has a team-tinted "LayerAdjust" half and a fixed-colour
   * "LayerStatic" half, and every half shares the same pivot origin -- so they must
   * all be drawn at ONE anchor. (x, y) is the CENTRE of the target box: the union
   * bounding box of the loaded layers is centred there, which keeps every character
   * aligned regardless of how many layers it has.
   */
  public drawCharacterPortrait(
    charIndex: number,
    team: number,
    x: number,
    y: number,
    alpha = 1,
  ): boolean {
    const code = this.resolveCharacterSpriteCode(charIndex);
    const sheets: GpuSpriteSheet[] = [];
    for (const layer of ["A", "B", "C"] as const) {
      const base = `Character/${code}-Portrait_${layer}`;
      const adj = this.getSpriteSync("Fx", `${base}LayerAdjust`, team);
      const sta = this.getSpriteSync("Fx", `${base}LayerStatic`);
      if (sta) sheets.push(sta);
      if (adj) sheets.push(adj);
    }
    if (sheets.length === 0) {
      void this.prefetchCharacterBase(charIndex);
      return false;
    }

    // Union bounding box in pivot-origin space: [left - pivotX, right - pivotX] x [top - pivotY, bottom - pivotY]
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of sheets) {
      const f = s.frames[0];
      if (!f) continue;
      x0 = Math.min(x0, f.left - f.pivotX);
      y0 = Math.min(y0, f.top - f.pivotY);
      x1 = Math.max(x1, f.right - f.pivotX);
      y1 = Math.max(y1, f.bottom - f.pivotY);
    }
    if (!Number.isFinite(x0)) {
      void this.prefetchCharacterBase(charIndex);
      return false;
    }

    const ox = x - (x0 + x1) / 2;
    const oy = y - (y0 + y1) / 2;
    let drew = false;
    for (const s of sheets) {
      drew = this.drawSpriteFrame(s, 0, ox, oy, [1, 1, 1, alpha]) || drew;
    }
    return drew;
  }

  private resolveShopSpriteTemplate(itemId: number): { archive: ArchiveName; tpl: ObjectTemplateEntry } | null {
    if (itemId <= 0) return null;
    const item = this.shopById.get(itemId);
    if (!item) return null;
    const [arcPart, namePart] = item.code.split(":");
    if (!arcPart || !namePart) return null;
    const arc = arcPart as ArchiveName;
    const map =
      arc === "CharTE"
        ? this.charByName
        : arc === "EmoTE"
          ? this.emoByName
          : this.fxByName;
    const tpl = map.get(namePart.toLowerCase());
    if (!tpl) return null;
    return { archive: arc, tpl };
  }

  public drawShopItemPreview(
    itemId: number,
    anchorX: number,
    anchorY: number,
    tick: number,
    scale = 1,
  ): boolean {
    const resolved = this.resolveShopSpriteTemplate(itemId);
    if (!resolved || resolved.tpl.states.length === 0) return false;
    const st = resolved.tpl.states[0]!;
    const frameIdx = this.resolveAnimFrameIndex(st, tick);

    // Try direct sprite path or LayerStatic
    const sheet =
      this.getSpriteSync(resolved.archive, st.imagePath) ??
      this.getSpriteSync(resolved.archive, `${st.imagePath}LayerStatic`);
    if (!sheet) return false;

    const f = sheet.frames[Math.max(0, Math.min(sheet.frames.length - 1, frameIdx))];
    if (!f) return false;
    // Center inside preview box around (anchorX, anchorY)
    const tex = sheet.textures[f.texIndex];
    if (!tex) return false;
    const w = f.width * scale;
    const h = f.height * scale;
    this.renderer.drawQuad(
      tex,
      anchorX - w * 0.5,
      anchorY - h * 0.5,
      w,
      h,
      f.left / tex.width,
      f.top / tex.height,
      f.right / tex.width,
      f.bottom / tex.height,
      [1, 1, 1, 1],
      false,
    );
    return true;
  }

  /**
   * CGOAvatar Paper-Doll Compositor!
   * Draws: Shadow -> Effect -> Back Wing/Flag -> Ship Mount -> Character LayerAdjust (HLS team-tinted!)
   * -> Character LayerStatic -> Equipped Clothes/Face/Cap -> Bubble/Shield!
   */
  public drawCharacterPaperDoll(opts: {
    charIndex: number;
    team: number;
    dir: Direction;
    moving: boolean;
    status: BomberStatus;
    animTick: number;
    anchorX: number;
    anchorY: number;
    zOffset?: number;
    mountType?: number;
    shieldTicks?: number;
    isCaptain?: boolean;
    hasTimebomb?: boolean;
    timebombSec?: number;
    equipped: EquippedAvatar;
    scale?: number;
    lobbyPose?: boolean;
  }): void {
    const scale = opts.scale ?? 1;
    const ax = opts.anchorX;
    const ay = opts.anchorY + (opts.zOffset ?? 0);

    // 1. Authentic Shadow/Shadow sprite (frame 0: 32x15 @ (-4, 15))
    const shadowSheet = this.getSpriteSync("Fx", "Shadow/Shadow");
    if (shadowSheet) {
      this.drawSpriteFrame(shadowSheet, 0, ax - 20 * scale, opts.anchorY, [1, 1, 1, 0.55], scale);
    } else {
      this.renderer.drawRect(
        ax - 12 * scale,
        opts.anchorY - 6 * scale,
        24 * scale,
        6 * scale,
        [0, 0, 0, 0.32],
      );
    }

    // 2. Equipped Effect (CharDeco aura under feet)
    if (opts.equipped.effect > 0) {
      this.drawShopItemPreview(opts.equipped.effect, ax, ay - 12 * scale, opts.animTick, scale * 0.9);
    }

    // 3. Back Wing / Flag when facing Left, Right, or Down
    if (opts.dir !== Direction.Up) {
      if (opts.equipped.wing > 0) {
        this.drawShopItemPreview(opts.equipped.wing, ax, ay - 22 * scale, opts.animTick, scale * 0.85);
      }
      if (opts.equipped.flag > 0) {
        this.drawShopItemPreview(opts.equipped.flag, ax + 10 * scale, ay - 28 * scale, opts.animTick, scale * 0.8);
      }
    }

    // 4. Select character template & state index (0..79 from Character/C00_A..C10_A!)
    const effChar = opts.charIndex === 8 ? 0 : Math.max(0, Math.min(10, opts.charIndex));
    const code = this.resolveCharacterSpriteCode(effChar);

    let tpl: ObjectTemplateEntry | undefined;
    let stateIdx = 0;
    const safeDir = opts.dir >= 0 && opts.dir <= 3 ? opts.dir : Direction.Down;

    if (opts.lobbyPose) {
      tpl =
        this.fxByName.get(`character/${code.toLowerCase()}_display_a`) ??
        this.fxByName.get("character/c00_display_a");
      stateIdx = 0; // Blink
    } else {
      tpl =
        this.fxByName.get(`character/${code.toLowerCase()}_a`) ??
        this.fxByName.get(`character/${code.toLowerCase()}`) ??
        this.fxByName.get("character/c00_a");

      if (opts.status === BomberStatus.Dying) {
        stateIdx = 1; // 01 Die
      } else if (opts.status === BomberStatus.Victory) {
        stateIdx = 3; // 03 Hurrah
      } else if (opts.status === BomberStatus.Trapped) {
        stateIdx = opts.moving ? 52 + safeDir : 56; // Locked In Move / Stop
      } else if (opts.status === BomberStatus.Ghost) {
        stateIdx = (opts.moving ? 44 : 48) + safeDir; // Ghost Walk / Stop
      } else if (opts.status === BomberStatus.Jumping) {
        stateIdx = 31 + safeDir; // Jump
      } else if ((opts.mountType ?? -1) >= 0) {
        stateIdx = (opts.moving ? 4 : 8) + safeDir; // Ride / Stop Ride
      } else {
        stateIdx = (opts.moving ? 20 : 12) + safeDir; // Walk / Stop
      }
    }

    // Mount under/around rider
    const mountYShift = (opts.mountType ?? -1) >= 0 ? -10 * scale : 0;
    if (!opts.lobbyPose && (opts.mountType ?? -1) >= 0) {
      const dirNames = ["Left", "Up", "Right", "Down"];
      const dName = dirNames[safeDir] ?? "Down";
      // Real Fx.idd ship sprites: Owl, Turtle0, Turtle1(super), Airship(ufo), Tank
      const mountPath =
        opts.mountType === 0
          ? `Ship/Owl-${dName}`
          : opts.mountType === 1
            ? `Ship/Turtle0-${dName}`
            : opts.mountType === 4
              ? `Ship/Turtle1-${dName}`
              : opts.mountType === 3
                ? `Ship/Tank_${dName.toLowerCase()}`
                : `Ship/Airship-${dName}`;
      const mSheet = this.getSpriteSync("Fx", mountPath);
      if (mSheet) {
        const mf = Math.floor(opts.animTick / 6) % Math.max(1, mSheet.frames.length);
        this.drawSpriteFrame(mSheet, mf, ax - 20 * scale, ay, [1, 1, 1, 1], scale);
      }
    }

    // 5. Render Character LayerAdjust (team HLS tinted!) + LayerStatic!
    const drawBaseX = opts.lobbyPose ? ax - 20 * scale : ax - 20 * scale;
    const drawBaseY = ay + mountYShift;
    const alpha = opts.status === BomberStatus.Ghost ? 0.55 : 1.0;

    let drewSprite = false;
    if (tpl && tpl.states.length > 0) {
      const st = tpl.states[Math.min(tpl.states.length - 1, stateIdx)] ?? tpl.states[0]!;
      const fIdx = this.resolveAnimFrameIndex(st, opts.animTick);

      const adjSheet = this.getSpriteSync("Fx", `${st.imagePath}LayerAdjust`, opts.team);
      const staSheet = this.getSpriteSync("Fx", `${st.imagePath}LayerStatic`);
      const plainSheet = !adjSheet && !staSheet ? this.getSpriteSync("Fx", st.imagePath) : null;

      if (adjSheet) {
        drewSprite =
          this.drawSpriteFrame(adjSheet, fIdx, drawBaseX, drawBaseY, [1, 1, 1, alpha], scale) ||
          drewSprite;
      }
      if (staSheet) {
        drewSprite =
          this.drawSpriteFrame(staSheet, fIdx, drawBaseX, drawBaseY, [1, 1, 1, alpha], scale) ||
          drewSprite;
      }
      if (plainSheet) {
        drewSprite =
          this.drawSpriteFrame(plainSheet, fIdx, drawBaseX, drawBaseY, [1, 1, 1, alpha], scale) ||
          drewSprite;
      }
    }

    if (!drewSprite) {
      // Trigger background prefetch for this character if not cached yet (no custom box placeholder!)
      void this.prefetchCharacterBase(effChar);
    }

    // 6. Equipped Clothes / Face / Head / Cap paper-doll overlays
    if (opts.equipped.body > 0) {
      this.drawShopItemPreview(opts.equipped.body, ax, drawBaseY - 14 * scale, opts.animTick, scale * 0.72);
    }
    if (opts.equipped.eyes > 0) {
      this.drawShopItemPreview(opts.equipped.eyes, ax, drawBaseY - 24 * scale, opts.animTick, scale * 0.65);
    }
    if (opts.equipped.head > 0) {
      this.drawShopItemPreview(opts.equipped.head, ax, drawBaseY - 32 * scale, opts.animTick, scale * 0.72);
    }
    if (opts.equipped.cap > 0) {
      this.drawShopItemPreview(opts.equipped.cap, ax, drawBaseY - 36 * scale, opts.animTick, scale * 0.75);
    }

    // Front Wing/Flag if facing Up
    if (opts.dir === Direction.Up) {
      if (opts.equipped.wing > 0) {
        this.drawShopItemPreview(opts.equipped.wing, ax, ay - 22 * scale, opts.animTick, scale * 0.85);
      }
      if (opts.equipped.flag > 0) {
        this.drawShopItemPreview(opts.equipped.flag, ax + 10 * scale, ay - 28 * scale, opts.animTick, scale * 0.8);
      }
    }

    // 7. Trapped Water Bubble overlay (Bomb/Bubble00)
    if (opts.status === BomberStatus.Trapped) {
      const bubTpl = this.fxByName.get("bomb/bubble");
      if (bubTpl) {
        this.drawFxTemplateState(
          bubTpl,
          "00 Lock",
          opts.animTick,
          ax - 20 * scale,
          ay + 2 * scale,
          [1, 1, 1, 0.88],
          scale,
        );
      }
    }

    // 8. Native Shield / Captain Flag / Timebomb HUD sprites above head (ZERO custom boxes/emojis!)
    if ((opts.shieldTicks ?? 0) > 0) {
      const shieldSheet = this.getSpriteSync("Fx", "Item/Shield");
      if (shieldSheet && shieldSheet.frames.length > 0) {
        const sf = Math.floor(opts.animTick / 4) % shieldSheet.frames.length;
        this.drawSpriteFrame(shieldSheet, sf, ax - 20 * scale, ay, [1, 1, 1, 0.88], scale);
      }
    }
    if (opts.isCaptain) {
      const capSheet = this.getSpriteSync("Fx", "Game/CaptainFlag");
      if (capSheet && capSheet.frames.length > 0) {
        const cf = Math.floor(opts.animTick / 6) % capSheet.frames.length;
        this.drawSpriteFrame(capSheet, cf, ax, ay - 24 * scale, [1, 1, 1, 1], scale);
      }
    }
    if (opts.hasTimebomb) {
      const tbSheet = this.getSpriteSync("Fx", "Game/TimebombIndicator");
      if (tbSheet && tbSheet.frames.length > 0) {
        const tf = Math.floor(opts.animTick / 6) % tbSheet.frames.length;
        this.drawSpriteFrame(tbSheet, tf, ax - 20 * scale, ay, [1, 1, 1, 1], scale);
      }
      const secStr = String(Math.max(0, opts.timebombSec ?? 0)).padStart(2, "0");
      const timerSheet = this.getSpriteSync("Fx", "Game/Timer");
      if (timerSheet && timerSheet.frames.length >= 10) {
        this.drawSpriteFrame(timerSheet, secStr.charCodeAt(0) - 48, ax - 11, ay - 78, [1, 0.45, 0.45, 1]);
        this.drawSpriteFrame(timerSheet, secStr.charCodeAt(1) - 48, ax + 1, ay - 78, [1, 0.45, 0.45, 1]);
      }
    }
  }
}
