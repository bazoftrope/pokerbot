import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'grammy'
import { PokerGame } from '../src/game.js'
import { Store } from '../src/store.js'
import type { Config } from '../src/types.js'

const CHAT_ID = -1001234567890

class FakeApi {
  readonly messages: Array<{ chatId: number; text: string; markup?: unknown }> = []
  private nextId = 1

  async sendMessage(chatId: number, text: string, options?: { reply_markup?: unknown }): Promise<{ message_id: number }> {
    this.messages.push({ chatId, text, markup: options?.reply_markup })
    return { message_id: this.nextId++ }
  }

  async editMessageText(
    chatId: number,
    _messageId: number,
    text: string,
    options?: { reply_markup?: unknown },
  ): Promise<true> {
    this.messages.push({ chatId, text, markup: options?.reply_markup })
    return true
  }
}

const settings: Config = {
  token: 'test',
  dbPath: ':memory:',
  startingChips: 1000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeoutMs: 300_000,
}

function makeEnv(count: number, botUsername = '') {
  const api = new FakeApi()
  const store = new Store(':memory:', settings.startingChips)
  const game = new PokerGame({ api } as unknown as Bot, store, settings, botUsername)
  for (let id = 1; id <= count; id++) {
    const user = { id, username: `p${id}`, first_name: `P${id}` }
    store.registerPlayer(CHAT_ID, user)
    store.markDmReady(user)
  }
  return { api, store, game }
}

function totalChips(store: Store): number {
  return store.getPlayers(CHAT_ID).reduce((sum, player) => sum + player.chips, 0)
}

test('все игроки доходят до ривера, фишки сохраняются', async () => {
  const { api, store, game } = makeEnv(3)
  await game.startRound(CHAT_ID, 'Тест')
  assert.ok(store.getRound(CHAT_ID)?.chatMessageId, 'сообщение чата создано')

  for (let guard = 0; guard < 100; guard++) {
    const round = store.getRound(CHAT_ID)!
    if (round.status === 'finished' || round.turnIndex === null) break
    const actor = round.players[round.turnIndex]
    await game.handleAction(CHAT_ID, actor.userId, actor.bet === round.currentBet ? 'check' : 'call')
  }

  const finished = store.getRound(CHAT_ID)!
  assert.equal(finished.status, 'finished')
  assert.equal(finished.stage, 'showdown')
  assert.equal(finished.board.length, 5)
  assert.equal(totalChips(store), 3000)
  const result = api.messages.filter((message) => message.chatId === CHAT_ID).at(-1)!.text
  assert.match(result, /🏆 <b>Раунд завершен!<\/b>/)
  assert.match(result, /Победитель:/)
})

test('фолд на префлопе отдаёт банк оставшемуся игроку', async () => {
  const { store, game } = makeEnv(2)
  await game.startRound(CHAT_ID, 'Тест')
  const round = store.getRound(CHAT_ID)!
  const actor = round.players[round.turnIndex!]
  await game.handleAction(CHAT_ID, actor.userId, 'fold')

  const chips = store.getPlayers(CHAT_ID).map((player) => player.chips)
  assert.equal(chips.reduce((a, b) => a + b, 0), 2000)
  assert.equal(chips.filter((value) => value === 990).length, 1)
  assert.equal(chips.filter((value) => value === 1010).length, 1)
  assert.equal(store.getRound(CHAT_ID)!.status, 'finished')
})

test('по таймеру не ответивший игрок получает автофолд', async () => {
  const { store, game } = makeEnv(4)
  await game.startRound(CHAT_ID, 'Тест')

  let round = store.getRound(CHAT_ID)!
  await game.handleAction(CHAT_ID, round.players[round.turnIndex!].userId, 'raise')
  for (let i = 0; i < 2; i++) {
    round = store.getRound(CHAT_ID)!
    await game.handleAction(CHAT_ID, round.players[round.turnIndex!].userId, 'call')
  }

  round = store.getRound(CHAT_ID)!
  assert.ok(round.timerDeadline !== null, 'таймер запущен после 3 ходов')
  const pendingId = round.players.find((player) => player.pending)!.userId
  round.timerDeadline = Date.now() - 1
  store.saveRound(round)

  await game.restoreTimers()

  const after = store.getRound(CHAT_ID)!
  assert.equal(after.players.find((player) => player.userId === pendingId)!.folded, true)
  assert.notEqual(after.stage, 'preflop')
  assert.equal(totalChips(store), 4000)
})

test('игрокам без ЛС показывается кнопка с deep link', async () => {
  const { api, store, game } = makeEnv(3, 'pokerbot')
  store.markDmNotReady(3)
  await game.startRound(CHAT_ID, 'Тест')
  const table = api.messages.filter((message) => message.chatId === CHAT_ID).at(-1)!
  assert.match(table.text, /Не участвуют/)
  assert.match(JSON.stringify(table.markup), /t\.me\/pokerbot\?start=poker/)
})

test('новый раунд запускается только после следующей команды', async () => {
  const { store, game } = makeEnv(3)
  await game.startRound(CHAT_ID, 'Тест')
  await game.handleAction(CHAT_ID, store.getRound(CHAT_ID)!.players[0].userId, 'fold')
  await game.startRound(CHAT_ID, 'Тест')
  assert.equal(store.getRound(CHAT_ID)!.roundId, 1, 'активный раунд не перезаписан')
})
