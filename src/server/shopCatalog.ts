import { AvatarSlot, type ShopItemDTO } from "../shared/protocol.ts";
import type { ServerPackManager } from "./packReader.ts";

const CLOTHES_NAMES = [
  "海盜船長服",
  "皇家騎士鎧甲",
  "夏日海灘泳裝",
  "街頭潮流帽T",
  "學園制服套裝",
  "功夫宗師道服",
  "粉紅甜心洋裝",
  "暗夜忍者裝",
  "雪國毛絨大衣",
  "太空探險宇航服",
  "星光偶像禮服",
  "黃金戰神套裝",
];

const CAP_NAMES = [
  "海盜三角帽",
  "黃金皇冠",
  "天使光環頭飾",
  "惡魔小角頭飾",
  "可愛兔耳髮箍",
  "棒球潮流鴨舌帽",
  "魔法師尖頂帽",
  "熊貓毛絨帽",
  "夏日草編遮陽帽",
  "貴族紳士高帽",
];

const HAIR_NAMES = [
  "飄逸銀白長髮",
  "熱血火焰刺蝟頭",
  "甜美雙馬尾",
  "貴族金色捲髮",
  "清爽湛藍短髮",
  "櫻花粉浪漫長髮",
];

const FACE_NAMES = [
  "酷炫太陽眼鏡",
  "害羞紅撲撲腮紅",
  "名偵探單片眼鏡",
  "閃亮星星眼妝",
  "海盜獨眼罩",
  "甜蜜愛心臉貼",
];

const WING_NAMES = [
  "純白熾天使之翼",
  "墮落黑曜惡魔翼",
  "夢幻精靈蝴蝶翼",
  "黃金鳳凰羽翼",
  "皇家紅絲絨披風",
  "彩虹霓虹推進器",
];

const FLAG_NAMES = [
  "台灣水球冠軍旗",
  "海盜骷髏戰旗",
  "皇家獅子徽章旗",
  "愛心邱比特背飾",
  "黃金招財貓背飾",
  "雷霆戰鼓背旗",
];

const BOMB_NAMES = [
  "彩虹果凍水球",
  "黃金閃耀水球",
  "愛心粉紅水球",
  "海盜骷髏水球",
  "西瓜清涼水球",
  "星光銀河水球",
  "南瓜萬聖水球",
  "雪花冰晶水球",
  "微笑太陽水球",
  "皇家寶石水球",
];

const EFFECT_NAMES = [
  "彩虹殘影光環",
  "黃金閃電氣場",
  "櫻花紛飛特效",
  "星辰守護光圈",
  "烈焰戰神光環",
  "冰雪結晶特效",
];

const BALLOON_NAMES = [
  "VIP皇家名牌框",
  "甜蜜情侶愛心框",
  "星光閃耀名牌",
  "海盜藏寶圖名牌",
  "勝利煙火慶典",
  "冠軍黃金名牌",
];

export function buildShopCatalog(packs: ServerPackManager): ShopItemDTO[] {
  const catalog: ShopItemDTO[] = [];
  let nextId = 1001;

  const desc = (idx: number, fallback: string): string => {
    const raw = packs.itemDescriptions.get(idx);
    if (raw && raw.length > 4) return raw;
    return fallback;
  };

  // 1. Scan CharTE templates for AvatarDeco, BombDeco, CharDeco
  let clothesIdx = 0;
  let capIdx = 0;
  let hairIdx = 0;
  let faceIdx = 0;
  let wingIdx = 0;
  let flagIdx = 0;
  let bombIdx = 0;
  let effectIdx = 0;

  for (const tpl of packs.charTemplates) {
    if (tpl.isFolder) continue;
    const name = tpl.name;

    if (name.startsWith("AvatarDeco/")) {
      const sub = name.slice(11); // e.g. A06_40_0001
      const parts = sub.split("_");
      const kindCode = parts[1] ?? "40";

      if ((kindCode === "40" || kindCode === "41") && clothesIdx < 28) {
        const label = `${CLOTHES_NAMES[clothesIdx % CLOTHES_NAMES.length]} #${clothesIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: desc(12, "穿上專屬造型服飾，在遊戲大廳與對戰中展現獨特魅力！"),
          tab: 0,
          slot: AvatarSlot.Clothes,
          priceLucci: 4500 + (clothesIdx % 5) * 1500,
          priceCash: clothesIdx % 3 === 0 ? 60 : 0,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        clothesIdx++;
      } else if (kindCode === "10" && capIdx < 24) {
        const label = `${CAP_NAMES[capIdx % CAP_NAMES.length]} #${capIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: desc(12, "精緻帽子頭飾，可與各式髮型服裝自由混搭！"),
          tab: 1,
          slot: AvatarSlot.Cap,
          priceLucci: 3500 + (capIdx % 4) * 1200,
          priceCash: capIdx % 4 === 0 ? 45 : 0,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        capIdx++;
      } else if ((kindCode === "20" || kindCode === "21") && hairIdx < 18) {
        const label = `${HAIR_NAMES[hairIdx % HAIR_NAMES.length]} #${hairIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: "潮流造型髮飾，讓你的角色煥然一新！",
          tab: 1,
          slot: AvatarSlot.Head,
          priceLucci: 3200 + (hairIdx % 4) * 1000,
          priceCash: 0,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        hairIdx++;
      } else if (kindCode === "30" && faceIdx < 16) {
        const label = `${FACE_NAMES[faceIdx % FACE_NAMES.length]} #${faceIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: "超人氣臉部表情配件，吸睛度百分百！",
          tab: 2,
          slot: AvatarSlot.Face,
          priceLucci: 2800 + (faceIdx % 3) * 900,
          priceCash: 0,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        faceIdx++;
      } else if (kindCode === "50" && wingIdx < 16) {
        const label = `${WING_NAMES[wingIdx % WING_NAMES.length]} #${wingIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: "華麗背部羽翼與披風，奔跑時綻放耀眼風采！",
          tab: 4,
          slot: AvatarSlot.Wing,
          priceLucci: 8000,
          priceCash: 90,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        wingIdx++;
      } else if (kindCode === "60" && flagIdx < 16) {
        const label = `${FLAG_NAMES[flagIdx % FLAG_NAMES.length]} #${flagIdx + 1}`;
        catalog.push({
          itemId: nextId++,
          code: `CharTE:${name}`,
          name: label,
          description: "榮耀戰旗背飾，象徵水球王者的威嚴！",
          tab: 4,
          slot: AvatarSlot.Flag,
          priceLucci: 5000,
          priceCash: 50,
          minLevel: 1,
          isPackage: false,
          packageItems: [],
        });
        flagIdx++;
      }
    } else if (name.startsWith("BombDeco/") && bombIdx < 24) {
      const label = `${BOMB_NAMES[bombIdx % BOMB_NAMES.length]} #${bombIdx + 1}`;
      catalog.push({
        itemId: nextId++,
        code: `CharTE:${name}`,
        name: label,
        description: "裝備後在對戰中放置的水球將變成專屬夢幻外觀！",
        tab: 3,
        slot: AvatarSlot.BombSkin,
        priceLucci: 6500 + (bombIdx % 4) * 1500,
        priceCash: bombIdx % 2 === 0 ? 80 : 0,
        minLevel: 1,
        isPackage: false,
        packageItems: [],
      });
      bombIdx++;
    } else if (name.startsWith("CharDeco/") && effectIdx < 16) {
      const label = `${EFFECT_NAMES[effectIdx % EFFECT_NAMES.length]} #${effectIdx + 1}`;
      catalog.push({
        itemId: nextId++,
        code: `CharTE:${name}`,
        name: label,
        description: "角色專屬腳底光環與動態特效！",
        tab: 3,
        slot: AvatarSlot.Effect,
        priceLucci: 7500,
        priceCash: 85,
        minLevel: 1,
        isPackage: false,
        packageItems: [],
      });
      effectIdx++;
    }
  }

  // 2. Scan EmoTE for IDDeco & Fanfare
  let balloonIdx = 0;
  for (const tpl of packs.emoTemplates) {
    if (tpl.isFolder) continue;
    if ((tpl.name.startsWith("IDDeco/") || tpl.name.startsWith("Fanfare/")) && balloonIdx < 18) {
      const label = `${BALLOON_NAMES[balloonIdx % BALLOON_NAMES.length]} #${balloonIdx + 1}`;
      catalog.push({
        itemId: nextId++,
        code: `EmoTE:${tpl.name}`,
        name: label,
        description: desc(8, "在準備室與勝利結算畫面展示專屬名牌背景與煙火特效！"),
        tab: 5,
        slot: AvatarSlot.Balloon,
        priceLucci: 4000,
        priceCash: 40,
        minLevel: 1,
        isPackage: false,
        packageItems: [],
      });
      balloonIdx++;
    }
  }

  // 3. Functional Items (Tab 5)
  const consumables: Omit<ShopItemDTO, "itemId">[] = [
    {
      code: "Fx:Item/ItemNiddle",
      name: "急救針筒組合 (50個)",
      description: desc(9, "被水球困住時按 Ctrl 鍵立即刺破水球自救！"),
      tab: 5,
      slot: AvatarSlot.Consumable,
      priceLucci: 2500,
      priceCash: 25,
      minLevel: 1,
      isPackage: false,
      packageItems: [],
    },
    {
      code: "Fx:Item/Shield",
      name: "黃金防護罩組 (30個)",
      description: desc(10, "按 Alt 鍵啟動短暫無敵護盾，抵擋水柱爆炸！"),
      tab: 5,
      slot: AvatarSlot.Consumable,
      priceLucci: 3500,
      priceCash: 35,
      minLevel: 1,
      isPackage: false,
      packageItems: [],
    },
    {
      code: "Fx:Item/CoupleNiddle",
      name: "情侶愛心戒指禮盒",
      description: "與心儀的夥伴締結情侶關係，共享專屬情侶光環與紅利！",
      tab: 5,
      slot: AvatarSlot.Consumable,
      priceLucci: 12000,
      priceCash: 120,
      minLevel: 1,
      isPackage: false,
      packageItems: [],
    },
    {
      code: "Fx:Gachapon/BazziLotCard",
      name: "幸運轉蛋代幣 (10枚)",
      description: "可在轉蛋機 (Slot Stage) 抽取稀有絕版造型與傳說水球！",
      tab: 5,
      slot: AvatarSlot.Consumable,
      priceLucci: 5000,
      priceCash: 50,
      minLevel: 1,
      isPackage: false,
      packageItems: [],
    },
  ];
  for (const c of consumables) {
    catalog.push({ itemId: nextId++, ...c });
  }

  // 4. Luxury Multi-Item Packages (Tab 6 - PackageMap reconstruction!)
  const firstClothes = catalog.find((i) => i.slot === AvatarSlot.Clothes)?.itemId ?? 1001;
  const firstCap = catalog.find((i) => i.slot === AvatarSlot.Cap)?.itemId ?? 1002;
  const firstWing = catalog.find((i) => i.slot === AvatarSlot.Wing)?.itemId ?? 1003;
  const firstBomb = catalog.find((i) => i.slot === AvatarSlot.BombSkin)?.itemId ?? 1004;
  const firstEffect = catalog.find((i) => i.slot === AvatarSlot.Effect)?.itemId ?? 1005;

  catalog.push({
    itemId: nextId++,
    code: "Fx:Character/C09_Display_A",
    name: "尊爵藍寶皇家大禮包",
    description: "一次擁有皇家服飾、皇冠頭飾、熾天使羽翼與專屬造型水球超值組合！",
    tab: 6,
    slot: AvatarSlot.Clothes,
    priceLucci: 18800,
    priceCash: 199,
    minLevel: 1,
    isPackage: true,
    packageItems: [firstClothes, firstCap, firstWing, firstBomb],
  });

  catalog.push({
    itemId: nextId++,
    code: "Fx:Character/C10_Display_A",
    name: "璀璨星光女神全套禮包",
    description: "內含星光偶像服、光環特效、夢幻造型水球，全場焦點就是你！",
    tab: 6,
    slot: AvatarSlot.Clothes,
    priceLucci: 16800,
    priceCash: 168,
    minLevel: 1,
    isPackage: true,
    packageItems: [firstClothes + 1, firstEffect, firstBomb + 1],
  });

  return catalog;
}
