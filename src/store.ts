import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ChatPlayer, RoundState } from './types.js'

export interface TelegramUser {
  id: number
  username?: string | null
  first_name: string
  is_bot?: boolean
}

export class Store {
  private readonly db: Database.Database

  constructor(dbPath: string, private readonly startingChips: number) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id INTEGER PRIMARY KEY,
        dealer_index INTEGER NOT NULL DEFAULT 0,
        round_counter INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        dm_ready INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS players (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        first_name TEXT NOT NULL,
        chips INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS rounds (
        chat_id INTEGER PRIMARY KEY,
        round_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  ensureChat(chatId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO chats (chat_id) VALUES (?)').run(chatId)
  }

  registerPlayer(chatId: number, user: TelegramUser): void {
    if (user.is_bot) return
    this.ensureChat(chatId)
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO users (user_id, username, first_name, dm_ready)
      VALUES (@userId, @username, @firstName, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name
    `).run({ userId: user.id, username: user.username ?? null, firstName: user.first_name })
    this.db.prepare(`
      INSERT INTO players (chat_id, user_id, username, first_name, chips, last_seen)
      VALUES (@chatId, @userId, @username, @firstName, @chips, @now)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_seen = excluded.last_seen
    `).run({
      chatId,
      userId: user.id,
      username: user.username ?? null,
      firstName: user.first_name,
      chips: this.startingChips,
      now,
    })
  }

  markDmReady(user: TelegramUser): void {
    this.db.prepare(`
      INSERT INTO users (user_id, username, first_name, dm_ready)
      VALUES (@userId, @username, @firstName, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        dm_ready = 1
    `).run({ userId: user.id, username: user.username ?? null, firstName: user.first_name })
  }

  markDmNotReady(userId: number): void {
    this.db.prepare('UPDATE users SET dm_ready = 0 WHERE user_id = ?').run(userId)
  }

  getPlayers(chatId: number): ChatPlayer[] {
    const rows = this.db.prepare(`
      SELECT p.user_id AS userId, p.username AS username, p.first_name AS firstName,
             p.chips AS chips, COALESCE(u.dm_ready, 0) AS dmReady
      FROM players p
      LEFT JOIN users u ON u.user_id = p.user_id
      WHERE p.chat_id = ?
      ORDER BY p.last_seen ASC, p.user_id ASC
    `).all(chatId) as Array<Omit<ChatPlayer, 'dmReady'> & { dmReady: number }>
    return rows.map((row) => ({ ...row, dmReady: row.dmReady === 1 }))
  }

  getChips(chatId: number, userId: number): number {
    const row = this.db.prepare('SELECT chips FROM players WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as { chips: number } | undefined
    return row?.chips ?? 0
  }

  setChips(chatId: number, userId: number, chips: number): void {
    this.db.prepare('UPDATE players SET chips = ? WHERE chat_id = ? AND user_id = ?')
      .run(Math.max(0, Math.round(chips)), chatId, userId)
  }

  getChatMeta(chatId: number): { dealerIndex: number; roundCounter: number } {
    this.ensureChat(chatId)
    const row = this.db.prepare('SELECT dealer_index, round_counter FROM chats WHERE chat_id = ?')
      .get(chatId) as { dealer_index: number; round_counter: number }
    return { dealerIndex: row.dealer_index, roundCounter: row.round_counter }
  }

  setChatMeta(chatId: number, dealerIndex: number, roundCounter: number): void {
    this.db.prepare('UPDATE chats SET dealer_index = ?, round_counter = ? WHERE chat_id = ?')
      .run(dealerIndex, roundCounter, chatId)
  }

  saveRound(round: RoundState): void {
    this.db.prepare(`
      INSERT INTO rounds (chat_id, round_id, status, state, updated_at)
      VALUES (@chatId, @roundId, @status, @state, @updatedAt)
      ON CONFLICT(chat_id) DO UPDATE SET
        round_id = excluded.round_id,
        status = excluded.status,
        state = excluded.state,
        updated_at = excluded.updated_at
    `).run({
      chatId: round.chatId,
      roundId: round.roundId,
      status: round.status,
      state: JSON.stringify(round),
      updatedAt: Date.now(),
    })
  }

  getActiveRound(chatId: number): RoundState | null {
    const row = this.db.prepare("SELECT state FROM rounds WHERE chat_id = ? AND status = 'active'")
      .get(chatId) as { state: string } | undefined
    return row ? JSON.parse(row.state) as RoundState : null
  }

  getRound(chatId: number): RoundState | null {
    const row = this.db.prepare('SELECT state FROM rounds WHERE chat_id = ?')
      .get(chatId) as { state: string } | undefined
    return row ? JSON.parse(row.state) as RoundState : null
  }

  getActiveRounds(): RoundState[] {
    const rows = this.db.prepare("SELECT state FROM rounds WHERE status = 'active'").all() as Array<{ state: string }>
    return rows.map((row) => JSON.parse(row.state) as RoundState)
  }

  close(): void {
    this.db.close()
  }
}
