import fs from 'node:fs';
import path from 'node:path';
function emptyData() {
    return { chats: {}, users: {}, players: {}, rounds: {} };
}
export class Store {
    dbPath;
    startingChips;
    data = emptyData();
    constructor(dbPath, startingChips) {
        this.dbPath = dbPath;
        this.startingChips = startingChips;
        if (dbPath === ':memory:' || !fs.existsSync(dbPath))
            return;
        try {
            const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            this.data = {
                chats: parsed.chats ?? {},
                users: parsed.users ?? {},
                players: parsed.players ?? {},
                rounds: parsed.rounds ?? {},
            };
        }
        catch (error) {
            console.log(`Cannot read store ${dbPath}, starting empty:`, error);
        }
    }
    playerKey(chatId, userId) {
        return `${chatId}:${userId}`;
    }
    persist() {
        if (this.dbPath === ':memory:')
            return;
        fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
        const temporary = `${this.dbPath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.data));
        fs.renameSync(temporary, this.dbPath);
    }
    getChatIds() {
        return Object.keys(this.data.chats).map(Number);
    }
    ensureChat(chatId) {
        const key = String(chatId);
        if (this.data.chats[key])
            return;
        this.data.chats[key] = { dealerIndex: 0, roundCounter: 0 };
        this.persist();
    }
    registerPlayer(chatId, user) {
        if (user.is_bot)
            return;
        this.ensureChat(chatId);
        const userKey = String(user.id);
        const previousUser = this.data.users[userKey];
        this.data.users[userKey] = {
            userId: user.id,
            username: user.username ?? null,
            firstName: user.first_name,
            dmReady: previousUser?.dmReady ?? false,
        };
        const playerKey = this.playerKey(chatId, user.id);
        const previousPlayer = this.data.players[playerKey];
        this.data.players[playerKey] = {
            chatId,
            userId: user.id,
            username: user.username ?? null,
            firstName: user.first_name,
            chips: previousPlayer?.chips ?? this.startingChips,
            dmReady: previousUser?.dmReady ?? false,
            lastSeen: Date.now(),
        };
        this.persist();
    }
    markDmReady(user) {
        const key = String(user.id);
        this.data.users[key] = {
            userId: user.id,
            username: user.username ?? null,
            firstName: user.first_name,
            dmReady: true,
        };
        this.persist();
    }
    markDmNotReady(userId) {
        const user = this.data.users[String(userId)];
        if (user) {
            user.dmReady = false;
            this.persist();
        }
    }
    getPlayers(chatId) {
        return Object.values(this.data.players)
            .filter((player) => player.chatId === chatId)
            .map((player) => ({
            userId: player.userId,
            username: player.username,
            firstName: player.firstName,
            chips: player.chips,
            dmReady: this.data.users[String(player.userId)]?.dmReady ?? false,
        }))
            .sort((a, b) => {
            const left = this.data.players[this.playerKey(chatId, a.userId)]?.lastSeen ?? 0;
            const right = this.data.players[this.playerKey(chatId, b.userId)]?.lastSeen ?? 0;
            return left - right || a.userId - b.userId;
        });
    }
    getChips(chatId, userId) {
        return this.data.players[this.playerKey(chatId, userId)]?.chips ?? 0;
    }
    setChips(chatId, userId, chips) {
        const player = this.data.players[this.playerKey(chatId, userId)];
        if (!player)
            return;
        player.chips = Math.max(0, Math.round(chips));
        this.persist();
    }
    getChatMeta(chatId) {
        this.ensureChat(chatId);
        const meta = this.data.chats[String(chatId)];
        return { dealerIndex: meta.dealerIndex, roundCounter: meta.roundCounter };
    }
    setChatMeta(chatId, dealerIndex, roundCounter) {
        this.data.chats[String(chatId)] = { dealerIndex, roundCounter };
        this.persist();
    }
    saveRound(round) {
        this.data.rounds[String(round.chatId)] = structuredClone(round);
        this.persist();
    }
    getActiveRound(chatId) {
        const round = this.data.rounds[String(chatId)];
        return round?.status === 'active' ? structuredClone(round) : null;
    }
    getRound(chatId) {
        const round = this.data.rounds[String(chatId)];
        return round ? structuredClone(round) : null;
    }
    getActiveRounds() {
        return Object.values(this.data.rounds)
            .filter((round) => round.status === 'active')
            .map((round) => structuredClone(round));
    }
    close() {
        this.persist();
    }
}
