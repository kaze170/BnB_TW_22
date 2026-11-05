import { Database } from "bun:sqlite";
import {
  AvatarSlot,
  EMPTY_EQUIPPED,
  type EquippedAvatar,
  type MarketListingDTO,
  type NoteDTO,
  type OwnedItemDTO,
  type QuestDTO,
  type ShopItemDTO,
  type UserProfileDTO,
} from "../shared/protocol.ts";

export function expForNextLevel(level: number): number {
  return Math.floor(120 * Math.pow(level, 1.35));
}

export class GameDatabase {
  private readonly db: Database;

  constructor(filename = "bnb_tw22.sqlite") {
    this.db = new Database(filename, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
        level INTEGER NOT NULL DEFAULT 1,
        exp INTEGER NOT NULL DEFAULT 0,
        lucci INTEGER NOT NULL DEFAULT 999999,
        cash INTEGER NOT NULL DEFAULT 99999,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        guild_name TEXT NOT NULL DEFAULT '台灣水球同盟',
        couple_partner TEXT NOT NULL DEFAULT '',
        couple_ring_id INTEGER NOT NULL DEFAULT 0,
        default_char INTEGER NOT NULL DEFAULT 0,
        equipped_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS inventory (
        inv_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        equipped_slot INTEGER NOT NULL DEFAULT -1,
        expires_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        note_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL COLLATE NOCASE,
        content TEXT NOT NULL,
        gift_item_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS quest_claims (
        user_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        progress INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, quest_id)
      );

      CREATE TABLE IF NOT EXISTS market_listings (
        listing_id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id INTEGER NOT NULL,
        seller_name TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        price_lucci INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  public loginOrAutoRegister(
    username: string,
    password: string,
    starterItems: ShopItemDTO[],
  ): { ok: boolean; error?: string; profile?: UserProfileDTO } {
    const cleanUser = username.trim().slice(0, 20) || "Player1";
    const row = this.db
      .query("SELECT * FROM users WHERE username = ?")
      .get(cleanUser) as Record<string, unknown> | null;

    const passHash = Bun.hash(password || "bnb").toString(16);

    if (!row) {
      // Auto-register with generous 999,999 Lucci & 99,999 Cash!
      const nickname = cleanUser;
      this.db
        .query(
          `INSERT INTO users (username, password_hash, nickname, lucci, cash, equipped_json)
           VALUES (?, ?, ?, 999999, 99999, ?)`,
        )
        .run(cleanUser, passHash, nickname, JSON.stringify(EMPTY_EQUIPPED));

      const created = this.db
        .query("SELECT * FROM users WHERE username = ?")
        .get(cleanUser) as Record<string, unknown>;
      const uid = Number(created.id);

      // Gift starter items & welcome note
      for (const item of starterItems.slice(0, 4)) {
        this.grantItem(uid, item.itemId, 1);
      }
      this.sendNote(
        "系統管理員",
        nickname,
        "歡迎來到爆爆王 BnB 台灣 v22 WebGPU 重製版！已發放 999,999 Lucci 與 99,999 樂豆點至您的帳戶，祝您遊戲愉快！",
        0,
      );

      return { ok: true, profile: this.rowToProfile(created) };
    }

    if (String(row.password_hash) !== passHash && password.length > 0) {
      return { ok: false, error: "密碼錯誤，請重新輸入！" };
    }

    return { ok: true, profile: this.rowToProfile(row) };
  }

  public getProfileById(userId: number): UserProfileDTO | null {
    const row = this.db
      .query("SELECT * FROM users WHERE id = ?")
      .get(userId) as Record<string, unknown> | null;
    return row ? this.rowToProfile(row) : null;
  }

  public getProfileByNickname(nickname: string): UserProfileDTO | null {
    const row = this.db
      .query("SELECT * FROM users WHERE nickname = ?")
      .get(nickname.trim()) as Record<string, unknown> | null;
    return row ? this.rowToProfile(row) : null;
  }

  private rowToProfile(row: Record<string, unknown>): UserProfileDTO {
    let equipped: EquippedAvatar = { ...EMPTY_EQUIPPED };
    try {
      const parsed = JSON.parse(String(row.equipped_json || "{}"));
      equipped = { ...EMPTY_EQUIPPED, ...parsed };
    } catch {
      // ignore
    }
    const level = Number(row.level) || 1;
    return {
      userId: Number(row.id),
      username: String(row.username),
      nickname: String(row.nickname),
      level,
      exp: Number(row.exp) || 0,
      nextExp: expForNextLevel(level),
      lucci: Number(row.lucci) || 0,
      cash: Number(row.cash) || 0,
      wins: Number(row.wins) || 0,
      losses: Number(row.losses) || 0,
      draws: Number(row.draws) || 0,
      guildName: String(row.guild_name || ""),
      couplePartner: String(row.couple_partner || ""),
      coupleRingId: Number(row.couple_ring_id) || 0,
      defaultChar: Number(row.default_char) || 0,
      equipped,
    };
  }

  public addCurrency(userId: number, deltaLucci: number, deltaCash: number): UserProfileDTO | null {
    this.db
      .query("UPDATE users SET lucci = MAX(0, lucci + ?), cash = MAX(0, cash + ?) WHERE id = ?")
      .run(deltaLucci, deltaCash, userId);
    return this.getProfileById(userId);
  }

  public setLevel(userId: number, newLevel: number): UserProfileDTO | null {
    const clamped = Math.max(1, Math.min(450, newLevel));
    this.db
      .query("UPDATE users SET level = ?, exp = 0 WHERE id = ?")
      .run(clamped, userId);
    return this.getProfileById(userId);
  }

  public recordMatchOutcome(
    userId: number,
    outcome: "win" | "loss" | "draw",
    expGain: number,
    lucciGain: number,
    kills: number,
  ): { profile: UserProfileDTO; leveledUp: boolean } {
    const cur = this.getProfileById(userId);
    if (!cur) throw new Error("Missing user");

    let level = cur.level;
    let exp = cur.exp + expGain;
    let leveledUp = false;
    while (exp >= expForNextLevel(level) && level < 450) {
      exp -= expForNextLevel(level);
      level++;
      leveledUp = true;
    }

    const winInc = outcome === "win" ? 1 : 0;
    const lossInc = outcome === "loss" ? 1 : 0;
    const drawInc = outcome === "draw" ? 1 : 0;

    this.db
      .query(
        `UPDATE users
         SET level = ?, exp = ?, lucci = lucci + ?, wins = wins + ?, losses = losses + ?, draws = draws + ?
         WHERE id = ?`,
      )
      .run(level, exp, lucciGain, winInc, lossInc, drawInc, userId);

    // Advance quests
    this.advanceQuest(userId, 1, 1); // Play 3 matches
    if (outcome === "win") this.advanceQuest(userId, 2, 1); // Win 1 match
    if (kills > 0) this.advanceQuest(userId, 3, kills); // Pop 5 enemies

    return { profile: this.getProfileById(userId)!, leveledUp };
  }

  public getInventory(userId: number): OwnedItemDTO[] {
    const rows = this.db
      .query("SELECT * FROM inventory WHERE user_id = ? AND quantity > 0 ORDER BY inv_id ASC")
      .all(userId) as Record<string, unknown>[];
    return rows.map((r) => ({
      invId: Number(r.inv_id),
      itemId: Number(r.item_id),
      quantity: Number(r.quantity),
      equippedSlot: Number(r.equipped_slot),
      expiresAt: Number(r.expires_at),
    }));
  }

  public grantItem(userId: number, itemId: number, qty = 1): void {
    this.db
      .query(
        `INSERT INTO inventory (user_id, item_id, quantity)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      )
      .run(userId, itemId, qty);
  }

  public consumeItem(userId: number, itemId: number, qty = 1): boolean {
    const row = this.db
      .query("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?")
      .get(userId, itemId) as { quantity: number } | null;
    if (!row || row.quantity < qty) return false;
    this.db
      .query("UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ?")
      .run(qty, userId, itemId);
    this.db
      .query("DELETE FROM inventory WHERE user_id = ? AND item_id = ? AND quantity <= 0")
      .run(userId, itemId);
    return true;
  }

  public equipItem(
    userId: number,
    itemId: number,
    catalogMap: Map<number, ShopItemDTO>,
  ): UserProfileDTO | null {
    const profile = this.getProfileById(userId);
    if (!profile) return null;

    const inv = this.getInventory(userId);
    const owned = inv.find((i) => i.itemId === itemId);
    const shopItem = catalogMap.get(itemId);
    if (!owned || !shopItem || shopItem.slot === AvatarSlot.Consumable) return profile;

    const eq = { ...profile.equipped };
    const toggle = (cur: number) => (cur === itemId ? 0 : itemId);

    switch (shopItem.slot) {
      case AvatarSlot.Clothes:
        eq.body = toggle(eq.body);
        break;
      case AvatarSlot.Cap:
        eq.cap = toggle(eq.cap);
        break;
      case AvatarSlot.Head:
        eq.head = toggle(eq.head);
        break;
      case AvatarSlot.Face:
        eq.eyes = toggle(eq.eyes);
        break;
      case AvatarSlot.Wing:
        eq.wing = toggle(eq.wing);
        break;
      case AvatarSlot.Flag:
        eq.flag = toggle(eq.flag);
        break;
      case AvatarSlot.BombSkin:
        eq.bombSkin = toggle(eq.bombSkin);
        break;
      case AvatarSlot.Effect:
        eq.effect = toggle(eq.effect);
        break;
      case AvatarSlot.Balloon:
        eq.balloon = toggle(eq.balloon);
        break;
    }

    this.db
      .query("UPDATE users SET equipped_json = ? WHERE id = ?")
      .run(JSON.stringify(eq), userId);

    // Sync equipped_slot column in inventory
    this.db.query("UPDATE inventory SET equipped_slot = -1 WHERE user_id = ?").run(userId);
    const activeEntries: [number, AvatarSlot][] = [
      [eq.body, AvatarSlot.Clothes],
      [eq.cap, AvatarSlot.Cap],
      [eq.head, AvatarSlot.Head],
      [eq.eyes, AvatarSlot.Face],
      [eq.wing, AvatarSlot.Wing],
      [eq.flag, AvatarSlot.Flag],
      [eq.bombSkin, AvatarSlot.BombSkin],
      [eq.effect, AvatarSlot.Effect],
      [eq.balloon, AvatarSlot.Balloon],
    ];
    for (const [id, slot] of activeEntries) {
      if (id > 0) {
        this.db
          .query("UPDATE inventory SET equipped_slot = ? WHERE user_id = ? AND item_id = ?")
          .run(slot, userId, id);
      }
    }

    return this.getProfileById(userId);
  }

  public addFriend(userId: number, friendId: number): void {
    if (userId === friendId) return;
    this.db
      .query("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)")
      .run(userId, friendId);
    this.db
      .query("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)")
      .run(friendId, userId);
  }

  public removeFriend(userId: number, friendId: number): void {
    this.db.query("DELETE FROM friends WHERE user_id = ? AND friend_id = ?").run(userId, friendId);
  }

  public getFriendIds(userId: number): number[] {
    const rows = this.db
      .query("SELECT friend_id FROM friends WHERE user_id = ?")
      .all(userId) as { friend_id: number }[];
    return rows.map((r) => Number(r.friend_id));
  }

  public setCouple(userA: number, nickA: string, userB: number, nickB: string, ringId: number): void {
    this.db
      .query("UPDATE users SET couple_partner = ?, couple_ring_id = ? WHERE id = ?")
      .run(nickB, ringId, userA);
    this.db
      .query("UPDATE users SET couple_partner = ?, couple_ring_id = ? WHERE id = ?")
      .run(nickA, ringId, userB);
  }

  public sendNote(sender: string, receiver: string, content: string, giftItemId = 0): void {
    this.db
      .query(
        `INSERT INTO notes (sender, receiver, content, gift_item_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sender, receiver, content.slice(0, 300), giftItemId, Date.now());
  }

  public getNotes(nickname: string): NoteDTO[] {
    const rows = this.db
      .query("SELECT * FROM notes WHERE receiver = ? ORDER BY note_id DESC LIMIT 40")
      .all(nickname) as Record<string, unknown>[];
    return rows.map((r) => ({
      noteId: Number(r.note_id),
      sender: String(r.sender),
      receiver: String(r.receiver),
      content: String(r.content),
      giftItemId: Number(r.gift_item_id),
      createdAt: Number(r.created_at),
      isRead: Number(r.is_read) !== 0,
    }));
  }

  public advanceQuest(userId: number, questId: number, delta: number): void {
    this.db
      .query(
        `INSERT INTO quest_claims (user_id, quest_id, claimed, progress)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(user_id, quest_id) DO UPDATE SET progress = progress + excluded.progress`,
      )
      .run(userId, questId, delta);
  }

  public getQuests(userId: number): QuestDTO[] {
    const defs: Omit<QuestDTO, "progress" | "claimed">[] = [
      {
        questId: 1,
        title: "熱身水球大戰",
        description: "完成 3 場任意模式對戰",
        target: 3,
        rewardLucci: 15000,
        rewardCash: 100,
        rewardExp: 350,
      },
      {
        questId: 2,
        title: "首勝榮耀",
        description: "在對戰中獲得 1 場勝利",
        target: 1,
        rewardLucci: 20000,
        rewardCash: 150,
        rewardExp: 500,
      },
      {
        questId: 3,
        title: "水球神射手",
        description: "累積擊破 5 名對手或怪物水球",
        target: 5,
        rewardLucci: 30000,
        rewardCash: 250,
        rewardExp: 800,
      },
    ];
    const rows = this.db
      .query("SELECT * FROM quest_claims WHERE user_id = ?")
      .all(userId) as { quest_id: number; claimed: number; progress: number }[];
    const byId = new Map(rows.map((r) => [r.quest_id, r]));

    return defs.map((d) => {
      const st = byId.get(d.questId);
      return {
        ...d,
        progress: Math.min(d.target, st?.progress ?? 0),
        claimed: (st?.claimed ?? 0) !== 0,
      };
    });
  }

  public claimQuest(userId: number, questId: number): { ok: boolean; profile?: UserProfileDTO } {
    const quests = this.getQuests(userId);
    const q = quests.find((x) => x.questId === questId);
    if (!q || q.claimed || q.progress < q.target) return { ok: false };
    this.db
      .query("UPDATE quest_claims SET claimed = 1 WHERE user_id = ? AND quest_id = ?")
      .run(userId, questId);
    this.addCurrency(userId, q.rewardLucci, q.rewardCash);
    const res = this.recordMatchOutcome(userId, "draw", q.rewardExp, 0, 0);
    return { ok: true, profile: res.profile };
  }

  public listMarketItems(): MarketListingDTO[] {
    const rows = this.db
      .query("SELECT * FROM market_listings ORDER BY listing_id DESC LIMIT 80")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      listingId: Number(r.listing_id),
      sellerId: Number(r.seller_id),
      sellerName: String(r.seller_name),
      itemId: Number(r.item_id),
      quantity: Number(r.quantity),
      priceLucci: Number(r.price_lucci),
      createdAt: Number(r.created_at),
    }));
  }

  public createMarketListing(
    sellerId: number,
    sellerName: string,
    itemId: number,
    qty: number,
    priceLucci: number,
  ): boolean {
    if (priceLucci <= 0 || qty <= 0) return false;
    if (!this.consumeItem(sellerId, itemId, qty)) return false;
    this.db
      .query(
        `INSERT INTO market_listings (seller_id, seller_name, item_id, quantity, price_lucci, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sellerId, sellerName, itemId, qty, priceLucci, Date.now());
    return true;
  }

  public buyMarketListing(buyerId: number, listingId: number): { ok: boolean; error?: string } {
    const row = this.db
      .query("SELECT * FROM market_listings WHERE listing_id = ?")
      .get(listingId) as Record<string, unknown> | null;
    if (!row) return { ok: false, error: "該拍賣商品已售出或下架！" };

    const buyer = this.getProfileById(buyerId);
    const price = Number(row.price_lucci);
    if (!buyer || buyer.lucci < price) {
      return { ok: false, error: "Lucci 餘額不足！" };
    }

    this.db.query("DELETE FROM market_listings WHERE listing_id = ?").run(listingId);
    this.addCurrency(buyerId, -price, 0);
    this.addCurrency(Number(row.seller_id), Math.floor(price * 0.95), 0); // 5% market fee
    this.grantItem(buyerId, Number(row.item_id), Number(row.quantity));
    return { ok: true };
  }

  public cancelMarketListing(userId: number, listingId: number): boolean {
    const row = this.db
      .query("SELECT * FROM market_listings WHERE listing_id = ? AND seller_id = ?")
      .get(listingId, userId) as Record<string, unknown> | null;
    if (!row) return false;
    this.db.query("DELETE FROM market_listings WHERE listing_id = ?").run(listingId);
    this.grantItem(userId, Number(row.item_id), Number(row.quantity));
    return true;
  }
}
