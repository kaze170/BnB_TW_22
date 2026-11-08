# BnB TW（彈水阿給 / Crazy Arcade BnB）— 原版逆向分析

> 本文件記錄對原版 Client 與 IDA 導出 `CA.exe.c` 的分析，作為 Web 還原工程的唯一事實依據。
> 所有實作必須交叉確認本文件與 `CA.exe.c` 原始行號。**除 Server 外嚴禁自創。**

## 0. 身分確認
- 遊戲：Nexon **Crazy Arcade BnB**，台灣版（Big5 繁體中文）。
- 主執行檔 `CA.exe`（5.59 MB），IDA Hex-Rays 9.4 導出 `CA.exe.c`（**668,313 行 / 17.9 MB**）。
- 原廠保護/平台層：`GameGuard.des`、`NPA.dll`/`NDA.dll`/`DWK.dll`（nProtect）、`NMCOSrv.exe`/`nmco3.dll`（Nexon 訊息層）、`Patcher.exe`/`NewPatcher.exe`、`Mss32.dll`（Miles 音效）、`binkw32.dll`（Bink 影片）、`ijl15.dll`（Intel JPEG）、`d3dx9_30.dll`。

## 1. 規模
| 項目 | 數量 |
|---|---|
| 解出資產檔 | 9,999（I16 9,762 / WAV 168 / MP3 47 / JPG 21）|
| 具名 C++ 類別 | 871 |
| 遊戲物件 CGO* | 105 |
| UI 控制項 CCtrl* | 27 |
| 封包發送點 CSendPacket | 1,283 |
| 畫面解析度 | **800 × 600**（所有 CAStage.jpg 證實）|
| 地圖格尺寸 | **40 × 40 px**（`CGOTile::sub_45D6CA`：`40*n`、`40*j+39`，行 107265）|

## 2. 資產格式（已破解並驗證）

### 2.1 I16 影像（`CDataI16::sub_678590` 行 537356；RLE 解碼 `sub_66F050`）
`.i16` 副檔名泛指「從封存解出的 entry」，內容可能是影像、文字/XML 或二進位表。
影像容器標頭（version==2）：
```
+0  u32 nImages   +4  u32 version(=2)   +8  u32 nFrames   +12 u32 flags
+16 frame table: nFrames × (u32 a, u32 b)   // 解碼時 width=b, height=a
+.. image headers: nImages × 48 bytes
+.. per frame: u32 compressedSize, 然後 compressedSize bytes 的 RLE 資料
```
RLE（每像素）：命令位元組 `cmd`，`run = cmd & 0x3F`：
- `cmd & 0x80`：透明 run（跳過 run 個像素）
- `cmd & 0x40`：純色 run（讀 1 個像素重複 run 次）
- 否则：字面 run（讀 run 個像素）
- **首字节 `(b & 0xC0)==0xC0`** 為 24-bit 旗標，跳過該字节；像素以 **BGR** 3 bytes 儲存。
- 否则像素為 16-bit **RGB565**。
- 像素轉換：`sub_68F380`（565→ARGB1555）、`sub_68F3A0`（24bit BGR→ARGB1555）。
- ✅ **已用 Python 還原 `Dlg_LO-NewID`、`LO_BtLogOk`（5 狀態按鈕）等，像素完全正確。**

### 2.2 文字/資料 entry
- 部分 entry 為 `u32 length + 內容`，內容為 Big5 XML/文字（如 `TileInfo/TileInfoList`、`XML/init`）。
- `init.txt`：`<init><nation name="taiwan"/><info name="couple" attr0="1"/><info name="quest" attr0="1"/></init>` → 台版開啟 couple/quest。
- `TileInfoList`：`<TileInfo><Tile Name="Tile00_Box/BoxGray" Data="<hex>"/>...` 定義所有地磚屬性。

### 2.3 Entry 加密（`sub_6731A0` 行 ~533xxx；XOR 串流_cipher）
逐 dword：`out[0]=MaskId ^ in[0] ^ 0x9C6C95CE`；`out[i]=out[i-1] ^ (in[i] ^ (i*i*(i+966)*(i+2020))) ^ 0x9C6C95CE`；尾 bytes 用最後 dword 逐字节 XOR。
- `MaskId` 來自 `.idx` 標頭。影像/TileInfoList 等已明文（MaskId==0）；**`Attr/BomberAttr`、`Attr/ItemAttr`、`Attr/MapGroup` 仍加密**（待 idx 解出 MaskId）。
- 壓縮路徑：檔名含特定子字串時走 `sub_6558B0`（inflate）。

### 2.4 SSD 字串表（`ssi1` magic + zlib）
- `csysstr.ssd`（系統字串，226 KB 解壓）、`filterstr.ssd`（聊天過濾）、`esfn.ssd`。
- 格式：`ssi1` + 標頭 + zlib stream（0x78 起）。解壓後為 Big5 字串表（key 長度+key + value 長度+value）。✅ 已驗證。

### 2.5 封存 `.idd` / `.idx`
- `.idd`：資料塊；`.idx`：索引（本身加密，magic 似 `bvat`）。`extracted/` 已含絕大多數解出內容。

### 2.6 字型 / 音效
- `Cx*.fft`：自訂字型（FxFont）。`CFontMan`/`CFxFontReal`（行 675120+）。
- 音效：WAV（Miles/Mss32）168 檔、MP3 47 檔（背景音樂）。

## 3. 架構

### 3.1 畫面流程（CStage 子類）
`CTitleStage → CLoginStage → CSelectServerStage → CSessionStage(頻道) → CLobbyStage → CPrepareStage(房間) → CGameStage(對戰) → 結算`
- 分支：`CLoginStageChina`、`CLobbyStageGuild`、`CPrepareStageGuild/Practice`、`CNewBomberManOnPrepareStage`。
- 其他畫面：`CShopStageNew`（商店）、`CUserMarketStage`（玩家市場）、`CExchangeStage`（交易）、`CChattingStage`、`CCreditStage`、`CSlotStage`。
- 結算：`CGOGameResult`、`CStageClear*`、`CGOStageClear*`。

### 3.2 遊戲物件（CGO*，105 類）
`CGOBomber`（玩家角色）、`CGOTimebombBomber`、`CGOAvatar`、`CGOTile`/`CGOTileFixed`/`CGOTileFixedBox`（地磚/障礙）、`CBombOwner`/`CItemBoxOwner`（炸彈/道具箱）、`CGONpcBasicMon`/`CGONpcAttackMon`/`CGONpcIceMon`/`CGOHedgehog`（怪物 AI）、`CGOEmotionActor`、`CGradeIconEffector`/`CLevelIconEffector`。
- 角色屬性 `CBomberAttr`：`m_nSpeed`、`m_nBombCount`、`m_nPower`…（讀 `Attr/BomberAttr`）。
- 道具 `Attr/ItemAttr`；地圖群組 `Attr/MapGroup`。

### 3.3 UI 框架（CCtrl*，27 類）
`CCtrlWnd`/`CDialogWnd`（視窗/對話框）、`CCtrlButton`/`CCtrlButtonWithText`（按鈕，多狀態圖）、`CCtrlEdit`/`CCtrlEditIME`/`CCtrlMultiEdit`（輸入框，含 IME）、`CCtrlImage`、`CCtrlMsgView`（聊天訊息）、`CTabList`/`CButtonList`。
- 按鈕圖為多狀態垂直堆疊（normal/hover/press/disabled…），如 `LO_BtLogOk` 99×150 = 5×(99×30)。
- UI 座標/版面配置刻在 exe 各 Stage 初始化函式（**還原時必須逐函式對照，嚴禁自創版面**）。

### 3.4 網路（NMCO / Nexon Messenger）
- `CSendPacket`/`CSendPacketBase`/`CReceivedPacketBase`、`CGameServerPacketHandler`、`CTypedPacket`、`CPacketCipherDegreeSelector`（封包加密）。
- Session 類：`CNMGSGeneralSession`、`CNMCSChatSession`、`CNMCRChatRoom`、`CNMFDSFileDownloadSession`…
- 事件：`CNMEvent`、`CNMFunc`。序列化：`CNMSerializable`/`CNMSerializableDecoder`。
- **Server 可自創**：以 Bun WebSocket 重現大廳/房間/對戰狀態同步即可，封包語意對照 client  handler。

### 3.5 渲染
- 原版 2D sprite blit：`CRenderDDraw7` / `CRenderD3D7` / `CRenderD3D9`（行 67AA30 / 681F70 / 68CFB0）。
- Web 還原：WebGPU 2D sprite batcher，重現 blit/alpha/colorkey 語意；必要時 Canvas2D fallback。

## 4. 工具鏈（已確認存在）
- **TypeScript `7.1.0-beta`**（npm `beta` tag；TS7 原生編譯器）。
- **Bun `1.4.4`**（2026-10-22 發布）。
- WebGPU（瀏覽器）。

## 5. 待解 / 風險
- `Attr/*` 與 `.idx` 的 MaskId 解密（核心數值：角色速度/炸彈數/威力、道具效果、地圖清單）。
- `.fft` 字型格式細節。
- 各 Stage 精確 UI 座標（需逐函式從 exe 提取）。
- 怪物 AI、爆炸連鎖、道具機率等 gameplay 常數（散落 exe，需逐一提取交叉確認）。
- 平台保護層（GameGuard/nProtect/Nexon 驗證/封包加密）在 Web 無意義 → 建議由自製 Server 模擬或略過。