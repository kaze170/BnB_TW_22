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
- 按鈕圖由 **logical images** 定址（normal/hover/press/disabled…）。早期「physical frame 垂直堆疊」假設已修正：I16 的 `nFrames` 是打包 texture pages，`nImages` 才是 exe 實際draw的影像；多個狀態可共用同一 page（見 §8.1）。
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
## 6. 已驗證：封存解密與核心資料格式（2026-11-08）

> 本節纠正 §2.3/§2.5 的待解狀態。所有結果已用原版 CRC 交叉驗證（325 個加密 entry 全數通過）。
> 工具：`tools/decrypt.py`、`tools/extract_original_data.py`；輸出：`data/original/*.json`。

### 6.1 `.idx` 索引加密（`sub_673110`）
- 串流 XOR：`out[0] = key ^ in[0]`；`out[i] = out[i-1] ^ in[i]`；尾 bytes 用最後 dword 逐字节 XOR。
- **key = 原始第一個 dword**（因為明文標頭 type==0，故 `key^in[0]==0`）。Fx=`0x719CAB30`，CharTE/EmoTE=`0x05B201FC`。
- 解密後標頭：`[type=0][ver=15][count]`。Fx 3948、CharTE 3046、EmoTE 3005 筆。

### 6.2 `.idx` entry 佈局（`sub_6749C0`，objdump 確認）
每筆：`[u32 nameLen][name][u32 relOffset][u32 size][u32 mask][u32 checksum]`。
- CDataFile 144-byte record：`name[128] / absOffset / size / mask / checksum`。
- **mask 是第三個 dword，checksum 是最後一個 dword**。先前 extracted/ 的 Attr/Map 被萃取工具誤用 checksum 做簡單 XOR，故仍為亂碼；正確做法是讀 `.idd` 原始塊再用 mask 跑 entry cipher。

### 6.3 Entry 加密（`sub_6731A0`）與 CRC（`sub_668E80`）
- `out[0]=mask ^ in[0] ^ 0x9C6C95CE`；`out[i]=out[i-1] ^ in[i] ^ (i*i*(i+966)*(i+2020)) ^ 0x9C6C95CE`；尾 bytes 用最後 dword XOR。mask==0 → 明文。
- CRC：poly `0x04C11DB7` 非反射（CRC-32/MPEG-2 形式），init=mask，無 final xor，**對解密後內容**計算；等於 idx checksum。checksum==0/1 時跳過檢查。
- 加密 entry 共 325：Fx 323（Attr×3、Map×319、ObjectTable×1）、CharTE/EmoTE ObjectTable 各 1。

### 6.4 核心表格（已解出）
- `ObjectTable/ObjectTable`（Fx）：`[u32 count]{[u32 len][name][u32 offset]}`，1187 個名稱。**地圖 grid 的數值 ID 即此表索引**（例：231=`Tile00_Ground/Road00`，244=`Tile00_Static/Tree00`）。`offset` 是 **絕對檔案偏移** 指向 `CGameObjectTemplate` description（`sub_4625B7`）：`[u32 groupCount]{[u32 nameLen][name][u32 assetLen][asset][u32 frameCount]{[i32 logicalImageIndex][i32 durationTicks]}}`；`0xffffffff` 代表無 description 的分類。已解出 1103 個 animated objects / 3478 groups / 19412 frame pairs → `data/original/objectAnimations.json`（§8.5）。
- `Attr/BomberAttr`：`{[u32 len][name][10×u32 stats]}`，11 角色 C00–C10。stat0=類別(0/1/2)。
  **語意已由 CGOBomber debug dump（`m_nSpeed`/`m_nBombCount`/`m_nBombPower`）與道具上限鉗制常式交叉確認**：
  stat1=基礎速度(`m_nSpeed`, `sub_5C6BEC`)、stat2=速度上限(`sub_447936`)、
  stat3=基礎炸彈數(`sub_5C6C27`)、stat4=炸彈上限(`CBombOwner sub_4385BE`)、
  stat5=基礎威力(`sub_5C6C62`)、stat6=威力上限(`sub_4386BE`)。
  C00=[0,5,7,1,10,1,7,…] → 速度5(上限7)、炸彈1(上限10)、威力1(上限7)。
- `Attr/ItemAttr`：header 3 dwords + 12 類別 + 131 道具（名稱×2 + 8 dwords）。
- `Attr/MapGroup`：3 群組（PraticeMapGroup…），各含地圖名稱清單。
- `TileInfo/TileInfoList`：`u32 xmlLen + TinyXML`；899 個 `<Tile Name Data>`，Data=104 hex chars → 52 bytes。dword0=type（0 ground/1 static/2 box/3 passable），dword1/2=寬高。
- `Map/*`（`sub_4E5845`，objdump 確認）：319 張，全為 **15×13**。標頭後依序：version(1000)、f1、f2、width、height、spawnCount、4 unknown、fieldA、2 skip、4 misc、2 skip、spawn pairs、linkCount+links、`grid[width*height]`（每格 2×i32：groundId/objectId，-1=無）、drop 清單（name+weight）。Village00 spawns=(13,11),(1,11),(1,1),(13,1)。

### 6.5 `.fft` 字型（`sub_676700`，已解出）
- 32-byte header；glyph count=65535（Unicode BMP）。`CxUni.fft`：width=12,height=12,bitmapBytes=18。
- 每 glyph：`[u8 advance][18 bytes bitmap]`，bitmap 為 **MSB-first、row-major、連續 packed**（12×12=144 bits）。空白 advance=6，中文 advance=12。
- 檔案後段另有 (w+2)×(h+2) 外框/粗體 bitmap。Web 還原：解碼成 atlas，依 advance 排字。

## 7. 已實作：原創字型 + 遊戲垂直切片（2026-11-08）

### 7.1 FxFont Web 還原（`src/client/ui/font.ts`）
- 解碼 `CxUni.fft`/`CxUniBold.fft` 主面 → 256×256 cell atlas（Unicode BMP 索引），依 per-glyph advance 排字，`source-in` 上色。
- `textSprite()`/`measureText()` 快取；字型未載入時退回系統字。`main.ts` 於載入 manifest 後 `await loadFonts()`。
- 伺服器 `/fonts/*` 路由指向 repo 根目錄的 `.fft`；`/data/*` 提供 `data/original/*.json`。
- _headless 驗證_：`tools/font_preview.ts`（@napi-rs/canvas）實際渲染「彈水阿給 BnB／登入 Login 123／房間準備中…」→ 3584 個點亮像素，FONT_OK。

### 7.2 遊戲模擬（`src/server/simulation.ts`，server 為原創）
- 消費解密原版資料：15×13 map grid、TileInfo type（0 ground/1 static/2 box/3 passable）、BomberAttr 角色數值、ItemAttr 掉落權重。
- TILE=40；十字傳播、靜態牆擋、紙箱破壞→權重掉落、連鎖引爆、道具拾取（炸彈/威力/速度/MaxPower/壞道具）、死亡/勝負。
- **更新週期已確認為 30ms fixed step**（§8.2）；`m_nSpeed` 以 px/30ms 換算。炸彈信管改用 exe practice/local 路徑的 **2000ms 參考值**（`sub_4E87D8(...,2000)`）；online fuse 由 server 決定，client 僅對 received schedule delta 做 >=1000ms 鉗制（`sub_4E8597`）。
- **火焰已改為 animation-driven `CGOFlame`（不再使用 interim TTL）**：normal bomb center group=`power-1`（`FireC01..`，9–18 pairs → **270–540ms**）；方向 group=`15*dir+14+remainingRange`（`FireL/U/R/D`，19 pairs → **570ms**），`remainingRange=power-(distance-1)`。每格 segment counter 初始 `-(distance-1)`（逐格 30ms 傳播 delay），`>=0` 才 active/造成傷害，logical image=counter，`>=frameCount` 移除（`sub_454188/45436D/454545/45FE8B`）；每格最多保留 15 個 segments。`sub_442FF7` 的 300 只是 effect-scheduling base，**已從 sim TTL 移除**。
- 簡單 bot AI：閃避即將爆炸格、相鄰紙箱/敵人時放炸彈後撤退、貪婪 seeking 紙箱/道具。空房補到地圖 spawn 數（至少 4、上限 8）；Village00 補 4，Village05 補 8。
- 30ms authoritative fixed step + catch-up cap 15 → `gameFrame` snapshot；`gameInput` 帶 seq。

### 7.3 Client GameStage（`src/client/stages/GameStage.ts`）
- ObjectTable 名稱→asset 路徑映射：`Tile00_Ground/Road00` → `Tile00/Road00`（去掉 `_類別` 後綴）。
- 原版 JPEG `Game/CAStage` 背景；map viewport origin 由 `sub_4E47B4` 確認：`x=40*(15-width)/2+20`、`y=40*(13-height)/2+41`（15×13 → (20,41)）。地磚用 pivot formula `x-pivotX, y-pivotY+39`，不再把 UI dx/dy 套到地磚。
- 畫 ground/object/item/bomb/fire/character（依 y 排序）；方向鍵/WASD 移動、空白鍵/Ctrl 放水球；累積 destroyed 格。Characters/bombs/items 使用 logical I16 images；右側 HUD 使用原版 Timer/ItemBox/Portrait/Exit assets。
- **爆炸/動畫 sprite 已對齊 ObjectTable**：`Flame/Flame` 是 ObjectTable template 名稱（不是缺失 asset），其 groups 指向 `Bomb/Fire00`（100 logical images / 53 pages）與 `Bomb/TimebombFrame`。Server snapshot 直接送 `asset/group/frame`，client 畫對應 logical image，不再用 age/role heuristic 或執行緒 flip。`Bomb/Bomb` default loop = 4 frames × 6 ticks = **720ms**；角色 walk groups 20–23 = 6 frames × 3 ticks = **540ms**（取代舊 120ms heuristic），idle 用 stop group frame 0。
- _headless 驗證_：`tools/ui_preview.ts` 用真實 Login/SelectServer/Lobby/Prepare/GameStage + @napi-rs/canvas 輸出預覽；`tools/game_preview.ts` 為其 legacy entry。GameStage 在 Village00 真實 simulation frame 渲染地圖/角色/水球/水波/道具/HUD。
- _WS 煙霧測試_：`tools/smoke_game.ts` SMOKE_OK；`tools/smoke_rooms.ts` ROOMS_OK（channel isolation、host/ready enforcement、character/map、start、in-game leave、cleanup）。

### 7.4 仍待（faithful 還原）
- 精確 online fuse；特殊炸彈/其餘角色動畫狀態（remote/blind/sprinkler、dash/ride 等；throw/ghost 見 §8.7）；道具完整效果（Punch/Hollow/Roller 等）。Normal flame lifetime/animation table 與逐格傳播 delay 已實作（§8.5）。
- UI 細節：channel tab 類別、房間 slot open/close、map preview thumbnails、IME/聊天過濾。結算報表 UI 已實作（§8.6）；online 計分/獎項 packet 語意仍待（server 原創 stats）。
- WebGPU 實機硬體呈現驗證。已用 transient headless Chromium（playwright-core + @sparticuz/chromium）跑完 login→channel→lobby→create→prepare→start→game→exit，Canvas2D fallback 零 page error；並修复 rAF 之間快速 click 遺失（`Input.clicked` 改由 release flag 決定）與 WebGPU texture upload（改用 256-byte row-aligned `writeTexture`，避免 SwiftShader external ImageBitmap/JPEG reference 失效）。Headless SwiftShader 可取得 adapter 但截圖不可靠，不作為視覺验收。

## 8. 已驗證：logical I16 images、30ms timing、原版 UI 座標（2026-11-08）

### 8.1 I16 logical images vs physical frames（`CDataI16::sub_678590`）
容器有兩個計數：`nImages`（48-byte headers）與 `nFrames`（RLE texture pages）。 exe 的 image accessors（`sub_599242/599253/599268/59927D/59928D/59929E/5992D0`）證實 header 欄位：
```
+0 dx, +4 dy, +8 delay/key, +12 frameIndex,
+16 sx, +20 sy, +24 ex, +28 ey, +32 w, +36 h, +40 pivotX, +44 pivotY
source rect = (sx, sy, ex-sx, ey-sy) inside frames[frameIndex]
```
範例（已寫入 `build/manifest.json` 的 `images`）：
- `Lobby/LB_Bt_T_Create`: 9 logical / 1 physical，133×63 狀態。
- `Prepare/PRE_Bt_Start`: 6 / 1，193×57。
- `SelectServerStage/CH_Bt_Channel`: 4 / 2；normal/pressed/disabled 共用 161×52 page（dx/dy=-3），hover 是 167×58 第二 page。
- `Lobby/LB_Bt_SessionSlot`: 4 / 2（272×81 + hover 279×89）。
- `Bomb/Fire00`: 100 / 53；`Character/C00-WalkDown_ALayerStatic`: 5 / 5（dy≈42, pivot 8,66）。
- `Prepare/PRE_Img`: 22 / 8（準備/室長 badges、check marks、mode icons）；`PRE_Ability`: 29 / 4；`Game/ItemCount`: 15 / 3；`Game/GameStageItem`: 27 / 2。
管線：`tools/i16.ts` 保留 headers；`tools/asset-pipeline.ts` 輸出 `images`；`engine/assets.ts` 的 `logicalImage()/imageCount()` 解析 source rect；`ui/controls.ts` Button 與 GameStage 动画改用 logical images。空 0×0 animation layer 輸出 1×1 transparent PNG（保留 0×0 rect），避免 ImageBitmap 拒絕零尺寸。

### 8.2 30ms fixed step（已證實）
- `CPrepareStage::sub_4D2048` 與 `CGameStage::sub_4F5658` 用 `timeGetTime` delta 除以 `0x1E`（30），catch-up 上限 15 updates。
- Server `GameServer.startSimulation` 用 `FixedStepper`（`src/shared/timing.ts`）在 30ms interval callback 內補幀；client stage update 改用 ms，GameStage input send threshold=30ms。
- 移動 `m_nSpeed` 是 pixels per 30ms update；已移除 interim `speed * dt / 50`。
- Practice/local explosion scheduling：`sub_4E87D8(..., 2000)`；client `sub_4E8597` 對 received delta 鉗制 >=1000。這支持 **2000ms practice fuse 參考**，但 online fuse 仍 server-authoritative。
- `sub_442FF7` 的 300 经 `sub_4E8968` → packet 108（`sub_4E8DC1`）消費，是 effect-scheduling base；**不得標為 fire TTL**。Exact flame lifetime 已由 ObjectTable animation count 解出並實作：`CGOFlame::sub_45436D` 在 counter >= `sub_45FE8B` frame count 時移除 segment；`Flame/Flame` center 9–18 ticks、directional 19 ticks（§8.5）。

### 8.3 原版 UI 座標（已提取並實作）
- SelectServer/channel（`sub_56DBA5/56D34E`）：tab (401,63)；arrows (490,508)/(676,508)；page buttons x=521+30i,y=511；10 channels/page x=428/595,y=218+56·floor(i/2)。Server 提供 5 pages×10 channels。
- Lobby（`sub_4C99DC/4C6D83/4C70F0`）：room slots x=214/490,y=121/205/289；room-info (+242,+49)；create/quick NM/MM (214/306/404/496,59)；ShowAll (595,66)、Practice (685,66)；room-page arrows (431/494,376)。Create dialog 使用 `Dlg_LB-NMCreate` + `Etc/BtOk/BtCancel`。
- Prepare（`sub_4D7376/4DB16C`）：8 slots x=27/133/239/345,y=94/239；Ready/Start (512,494)；AutoReady (719,525)；Selectmap (646,428)；Roominfo (344,61)。Character buttons 用 `Etc/SelCharaXX`（缺的以 `PRE_SelChara` 補）；map dialog 用 `Dlg_PRE-SelMap`。
- Game（`sub_4F5FDC/4E47B4`）：map origin 公式见 §7.3；Exit (647,561)；Timer digits 在右側 sidebar；ItemBox01 (647,466)。結果以 `CGOGameResult` 原版報表呈現（§8.6）：`Game/Win/Lose/Draw` banner + `PatResultDlg` 9-slice + `ResultInfoBar` + `ResultImg` rank/digits/bar/awards；Enter/OK 送 `returnToRoom` 回準備階段。

### 8.4 Server lifecycle（原創，語意對照 client）
已補：server/channel 隔離、`selectChannel`、mapList、duplicate nickname 拒絕、host/ready/start 驗證、create/join/leave、host transfer、in-game leave eliminate、character/map selection、post-game `returnToRoom`、bot fill 到 map spawn count（4–8）。gameEnd 後 room 進入封閉的 `results` 狀態；每位玩家保留自己的結算畫面，按 Enter/OK 後個別回準備階段（尚未全員返回前禁用開始/選圖/加入），全員返回或離開後才重設 ready 並開放房間。`tests/serverLifecycle.test.ts` 用 fake timer/socket 直接驗證此 round-trip。

### 8.5 ObjectTable animation tables（已解出並實作）
- **來源**：animation groups 不在 I16 header，也不在 `fxdynimginfo.ssd`（該檔是 `sub_49E093` 寫出、`sub_49E167` 讀取的 runtime cache，初始 commit 前已刪除，不需還原）。真正來源是 `ObjectTable/ObjectTable` 的 description payload：index loader `sub_462364`，parser `sub_4625B7`，template instantiation `sub_4630A8/4632D5`。
- **格式**：description = `[u32 groupCount]`，每 group = `[u32 nameLen][name][u32 assetLen][asset][u32 frameCount]` + `frameCount × (i32 logicalImageIndex, i32 durationTicks)`。duration 单位是 30ms fixed tick；`-1` 代表 hold。Full parse：**1103 objects / 3478 groups / 19412 frame pairs, 0 errors** → `data/original/objectAnimations.json`（`tools/extract_original_data.py::parse_object_animations`）。
- **Generic playback**（`CGameObjectTemplate::sub_45F608`）：每 tick counter+1；counter < duration 則停留當前 logical image；duration=-1 永久 hold；否則 advance 下一 pair，結尾依 loop flag 歸零或 clamp。`src/shared/animations.ts::animationImageAtTicks` 實作此語意。
- **CGOFlame**：`sub_45FE8B` 回傳 group 的 frame-pair count；`sub_45436D` 在 segment counter >= count 時移除；`sub_454545` 選最新 non-negative segment，設 group 並用 counter 當 logical image index。Normal scheduling：center `sub_4E61E3` 送 `power-1`；arms `sub_4E3CBE` 送 `15*dir + 14 + (power - distanceIndex)`，counter 初始 `0,-1,-2,…`。`Flame/Flame` 76 groups、asset `Bomb/Fire00`（group 75 `FireTimebomb` → `Bomb/TimebombFrame`），所有 duration=1：
  - groups 0–14 `FireC01..10` center：power 1–10 為 9,10,…,18 frames（270–540ms），11–15 cap 18。
  - groups 15–29 L、30–44 U、45–59 R、60–74 D：每 group **19 frames = 570ms**；power 1 tip 用各方向 `01`，高 power 在近中心格插入 body cells。
- **Other recovered loops**：`Bomb/Bomb` 5 groups（Default/Remote/Blind/Sprinkler×2），default `Bomb/Bomb00` pairs `(0,6),(1,6),(2,6),(3,6)` → 24 ticks = **720ms loop**。`Bomb/Bubble` Lock/ExpLive/ExpKill on `Bomb/Bubble00`。`Character/C00_A` 80 groups：Walk L/U/R/D groups 20–23 = 6 pairs × 3 ticks = **540ms**（sequence 0,1,2,0,3,4）；Stop 12–15 single frame @100；Throw 16–19 = (2,1,1,2) ticks = 180ms；Dash 76–79 9 frames。
- **實作/驗證**：server `GameSimulation` 每格保存最多 15 個 flame segments，snapshot 送 active segment 的 `asset/group/frame/ttl`；client `GameStage` 直接畫 Fire00 logical frame，炸彈/角色走路改用 duration tables。所有 manifest 可解析 group 的 logical image index 均落在 asset image count 內（0 out-of-range；character `_A` 對應 `_ALayerStatic`）。`tests/animations.test.ts` 驗證 group counts、center/arm selection、generic playback、power-1 center 9 ticks vs arms 19 ticks、power-2 第二環 delay 1 tick。`bun test` 13 pass / 492 expect；`bun run preview` UI_PREVIEW_OK；live `bun run smoke` ROOMS_OK + SMOKE_OK；headless Chromium BROWSER_SMOKE_OK（Canvas2D fallback, errors []）。

### 8.6 CGOGameResult 結算報表（已解出並實作）
- **vtable `0x7A9CFC`**（objdump .rdata 確認）：+124 `sub_454890` init、+128 `sub_4548CD` 背景、+136 `sub_454DAC` row loop、+140 `sub_4549C1` row bg、+148 `sub_454A43` portrait/name、+152 `sub_455C8E` 數字、+156 `sub_454E96` bar/awards。
- **背景**：`sub_4548CD` 用 `Game/PatResultDlg` 9 個 10×10 logical images 做 9-slice；常數 `0x208=520`、`0x212=530` → dialog 寬 **540**，alpha `0x80`。
- **Rows**：`sub_454DAC` 迭代 8 行，`y = 51 + 25*i`（`n51 < 251`）。`sub_454A43`：portrait x=`0x66=102`、name x=`0x79=121`（row stride `0x6c=108` bytes）。`sub_454E96`：score bar x=**329**、第二欄 x=**399**、award x=**458**。
- **Score bar**：`sub_454B49` width = `60*value/999`（cap 60）；先畫 `ResultImg` image45 底，再用 images46/47/48/49 依阈值 `<31`、`31–45`、`46–55`、`>=56` 组合，segment 寬 30/15/10/rest。`src/shared/resultLayout.ts` 實作並由 `tests/result.test.ts` 驗證。
- **Assets**：`Game/ResultImg` 80 logical images（0–9 digits、37–44 rank badges、45 bar bg、46–49 fill、50–71 badges/awards）；`Game/ResultInfoBar` 4 個 356×18 header（ID/擊破數/救援數/經驗值/LUCCI 等變體）；`Game/ResultImg2` 4 個特殊 award。
- **Server stats（原創）**：online 計分原本是 server-authoritative，exe client 只消費 packet fields（`sub_455957` row parser：character、two 0–999 bar values、award flags 等）。Vertical slice 由 `GameSimulation.result()` 產生 `GameResult.rows`：kills/deaths/boxes/items/score/rank/award；fire segment 帶 owner 以 credit 擊破，紙箱破壞 credit owner。Award 指派（57/64/66/68）為 server 原創，非 exe packet 語意。
- **驗證**：`bun test` 18 pass / 515 expect（含 result bar geometry + kill/box credit）；`bun run preview` 輸出 `build/game_result_preview.png`（真實 GameStage + 原版結算 assets）；live `bun run smoke` SMOKE_OK 且 `gameEnd.result.rows` 包含統計。


### 8.7 CGOBomber 動作狀態（部分已還原，轉場與死亡流程仍有差異）
- **來源及狀態機**：`CGOBomber` vtable `0x7A8E94`、更新 `sub_4503B5`；ObjectTable `Character/Cxx_A` groups：Die=1、Faint=2、Hurrah=3、Stop L/U/R/D=12–15、Throw=16–19、Walk=20–23、Start=24、Release=26、GhostAppear=43、Ghost Stop L/U/R/D=48–51、GhostDisappear=57。炸彈 packet `sub_4EC6AE` 以 `dir+16` 進 Throw；結束後回 `group-4`。勝利 `sub_44D9BC` 進 Hurrah；Die 結束後是否出現 Ghost 受 `this+12604` flag 控制；GhostAppear 結束進 group 51。Faint 的 `this+11552` counter 到 80 後回 group 15，`sub_4470AF` 的觸發路徑仍未找到。
- **ObjectTable 素材與長度**（C00，30ms/tick）：Throw 6 ticks = 180ms、Faint 動畫表 85 ticks = 2550ms、Die 92 ticks = 2760ms、GhostAppear 24 ticks = 720ms、Ghost Stop Down 30 ticks loop、Start 78 ticks、Hurrah 204 ticks、Release 16 ticks。Faint 表長度不等於 exe 狀態的 80-tick counter。角色動作使用 `Character/Cxx-Throw_A`、`Die`、`Faint`、`Hurrah_A`、`Start_A`、`GhostInOut`、`Ghost` 對應 `LayerStatic` I16；Die/Faint 是 `CDataI16Character`，不能再加上 `frames[].y`。
- **本切片的明確差異**：原版火焰擊殺路徑呼叫 Die（`sub_44A0C8`），不是已證實的 Faint→Die。為展示素材，目前自創 server 將致命火焰串成 **Faint→Die→GhostAppear→Ghost**，並以動畫表長度切換；這不代表原版死亡流程、Faint 觸發條件、ghost flag 或結算時序已被還原。尚未實作救援／復活，救援欄固定為 0。
- **同步與結算**：server snapshot 傳 `action/animGroup/animFrame/animTicks/animAsset`，client 依 server 狀態畫原圖。勝負與 `gameEnd` 仍立即決定；server 自創的 `presentation` 寬限期只推進動作、不推進遊戲、計分或時鐘，最後一個 frame 清除 flag，client 才顯示報表。這個寬限期**不是 exe 結算延遲的逆向結論**。
- **驗證**：`tests/characterActions.test.ts` 驗證 group、duration、放球轉場及賽後動作／時鐘凍結；`tools/character_preview.ts` 輸出 `build/character_action_preview.png`。Start 僅有 group 定義，目前不在開場自動播放；Release 和 GhostDisappear 尚未接上 gameplay。
