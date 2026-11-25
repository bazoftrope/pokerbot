import { InlineKeyboard, type Bot } from 'grammy'
import { cardsLabel, compareHands, handName, nextRaiseTo, shuffle, createDeck } from './poker.js'
import type { Store } from './store.js'
import type { Action, Card, Config, PlayerState, RoundState } from './types.js'

const STAGE_LABELS: Record<RoundState['stage'], string> = {
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Терн',
  river: 'Ривер',
  showdown: 'Шоудаун',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function mention(player: Pick<PlayerState, 'userId' | 'username' | 'firstName'>): string {
  if (player.username) return `@${escapeHtml(player.username)}`
  return `<a href="tg://user?id=${player.userId}">${escapeHtml(player.firstName)}</a>`
}

function isNotModified(error: unknown): boolean {
  const description = (error as { description?: string })?.description
    ?? (error as { message?: string })?.message
    ?? ''
  return String(description).toLowerCase().includes('not modified')
}

function callbackData(chatId: number, action: Action): string {
  return `pk:${chatId}:${action}`
}

function potOf(round: RoundState): number {
  return round.players.reduce((total, player) => total + player.committed, 0)
}

function isAction(value: string): value is Action {
  return value === 'fold' || value === 'check' || value === 'call' || value === 'raise'
}

export class PokerGame {
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private readonly chains = new Map<number, Promise<unknown>>()

  constructor(
    private readonly bot: Bot,
    private readonly store: Store,
    private readonly settings: Config,
    private readonly botUsername: string = '',
  ) {}

  private withLock<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    this.chains.set(chatId, run.catch(() => undefined))
    return run
  }

  async startRound(chatId: number, chatTitle: string): Promise<void> {
    await this.withLock(chatId, async () => {
      if (this.store.getActiveRound(chatId)) {
        await this.bot.api.sendMessage(chatId, 'Уже есть активный раунд. Дождитесь его завершения.')
        return
      }

      const allPlayers = this.store.getPlayers(chatId)
      const excluded = allPlayers.filter((player) => player.chips === 0).map((player) => `${mention(player)} (нет фишек)`)
      const candidates = allPlayers.filter((player) => player.chips > 0)
      if (candidates.length < 2) {
        await this.bot.api.sendMessage(
          chatId,
          `Для покера нужно минимум 2 игрока с фишками. Сейчас: ${candidates.length}.\n`
          + 'Напиши боту в ЛС /start, чтобы он мог прислать карты.',
        )
        return
      }

      const meta = this.store.getChatMeta(chatId)
      const deck = shuffle(createDeck())
      const roundId = meta.roundCounter + 1
      const dealt = candidates.map((candidate, index) => ({
        candidate,
        cards: [deck[index * 2], deck[index * 2 + 1]] as [Card, Card],
      }))

      const players: PlayerState[] = []
      for (const item of dealt) {
        if (!item.candidate.dmReady) {
          excluded.push(`${mention(item.candidate)} (нет /start в ЛС)`)
          continue
        }
        try {
          const message = await this.bot.api.sendMessage(
            item.candidate.userId,
            `🃏 <b>Покер · раунд #${roundId}</b> · ${escapeHtml(chatTitle)}\n`
            + `Ваши карты: <b>${cardsLabel(item.cards)}</b>\n`
            + 'Сейчас раздадим блайнды...',
            { parse_mode: 'HTML' },
          )
          players.push({
            userId: item.candidate.userId,
            username: item.candidate.username,
            firstName: item.candidate.firstName,
            cards: item.cards,
            bet: 0,
            committed: 0,
            chips: item.candidate.chips,
            folded: false,
            allIn: false,
            pending: false,
            dmMessageId: message.message_id,
          })
        } catch (error) {
          console.error(`Cannot DM user ${item.candidate.userId}:`, error)
          this.store.markDmNotReady(item.candidate.userId)
          excluded.push(`${mention(item.candidate)} (нет доступа в ЛС)`)
        }
      }

      if (players.length < 2) {
        for (const player of players) {
          await this.bot.api.sendMessage(player.userId, 'Раунд отменён: не набралось 2 игрока с доступными личными сообщениями.')
            .catch(() => undefined)
        }
        await this.bot.api.sendMessage(
          chatId,
          'Не удалось начать раунд: нужно минимум 2 игрока, которые написали боту /start в личные сообщения.',
        )
        return
      }

      const dealerIndex = meta.dealerIndex % players.length
      const smallBlindIndex = players.length === 2 ? dealerIndex : (dealerIndex + 1) % players.length
      const bigBlindIndex = (smallBlindIndex + 1) % players.length
      this.postBlind(players[smallBlindIndex], this.settings.smallBlind)
      this.postBlind(players[bigBlindIndex], this.settings.bigBlind)
      const postedBlind = Math.max(players[smallBlindIndex].bet, players[bigBlindIndex].bet)

      const round: RoundState = {
        chatId,
        chatTitle,
        notice: excluded.length ? `ℹ️ Не участвуют: ${excluded.join(', ')}. Нажмите кнопку ниже один раз — дальше карты будут приходить автоматически.` : null,
        roundId,
        status: 'active',
        stage: 'preflop',
        board: [],
        deck: deck.slice(players.length * 2),
        players,
        dealerIndex,
        turnIndex: null,
        currentBet: postedBlind,
        actionCount: 0,
        timerThreshold: Math.min(3, players.length),
        timerDeadline: null,
        chatMessageId: null,
        result: null,
        createdAt: Date.now(),
      }

      const firstActor = this.nextEligible(round, (bigBlindIndex + 1) % players.length, (player) => !player.folded)
      if (firstActor === null) throw new Error('No player can act preflop')
      round.turnIndex = firstActor
      round.players[firstActor].pending = true

      this.store.setChatMeta(chatId, (dealerIndex + 1) % players.length, roundId)
      this.store.saveRound(round)
      await this.renderAll(round)
    })
  }

  async refresh(chatId: number): Promise<void> {
    await this.withLock(chatId, async () => {
      const round = this.store.getActiveRound(chatId)
      if (!round) return
      this.store.saveRound(round)
      await this.renderAll(round)
    })
  }

  async handleAction(chatId: number, userId: number, action: string): Promise<void> {
    await this.withLock(chatId, async () => {
      const round = this.store.getActiveRound(chatId)
      if (!round || round.status !== 'active') return

      const index = round.players.findIndex((player) => player.userId === userId)
      if (index < 0 || round.turnIndex !== index || !isAction(action)) return

      const player = round.players[index]
      if (player.folded || !player.pending) return

      switch (action) {
        case 'fold':
          player.folded = true
          player.pending = false
          break
        case 'check':
          if (player.bet !== round.currentBet) return
          player.pending = false
          break
        case 'call': {
          const needed = round.currentBet - player.bet
          this.pay(player, Math.min(needed, player.chips))
          player.pending = false
          break
        }
        case 'raise': {
          const target = Math.min(
            nextRaiseTo(round.currentBet, this.settings.bigBlind),
            player.bet + player.chips,
          )
          if (target <= round.currentBet) return
          this.pay(player, target - player.bet)
          round.currentBet = player.bet
          player.pending = false
          for (const other of round.players) {
            if (other !== player && !other.folded && !other.allIn && other.chips > 0) other.pending = true
          }
          break
        }
      }

      round.actionCount++
      if (round.timerDeadline === null && round.actionCount >= round.timerThreshold) {
        round.timerDeadline = Date.now() + this.settings.actionTimeoutMs
      }

      const next = this.nextEligible(
        round,
        index + 1,
        (candidate) => !candidate.folded && candidate.pending && !candidate.allIn && candidate.chips > 0,
      )
      round.turnIndex = next
      if (next === null) await this.advanceStreet(round)

      this.store.saveRound(round)
      await this.renderAll(round)
      this.scheduleTimer(round)
    })
  }

  async restoreTimers(): Promise<void> {
    for (const round of this.store.getActiveRounds()) {
      if (round.timerDeadline !== null && round.timerDeadline <= Date.now()) {
        await this.withLock(round.chatId, () => this.onTimeout(round.chatId))
      } else {
        this.scheduleTimer(round)
      }
    }
  }

  private postBlind(player: PlayerState, amount: number): void {
    this.pay(player, Math.min(amount, player.chips))
  }

  private pay(player: PlayerState, amount: number): void {
    if (amount <= 0) return
    player.chips -= amount
    player.bet += amount
    player.committed += amount
    if (player.chips === 0) player.allIn = true
  }

  private nextEligible(
    round: RoundState,
    from: number,
    predicate: (player: PlayerState) => boolean,
  ): number | null {
    for (let offset = 0; offset < round.players.length; offset++) {
      const index = (from + offset) % round.players.length
      if (predicate(round.players[index])) return index
    }
    return null
  }

  private async advanceStreet(round: RoundState): Promise<void> {
    this.clearTimer(round.chatId)
    const contenders = round.players.filter((player) => !player.folded)

    if (contenders.length <= 1) {
      this.settle(round)
      return
    }
    if (round.stage === 'river' || contenders.every((player) => player.chips === 0)) {
      while (round.board.length < 5 && round.deck.length > 0) {
        round.board.push(round.deck.shift() as Card)
      }
      this.settle(round)
      return
    }

    this.dealBoard(round)
    round.stage = round.stage === 'preflop' ? 'flop' : round.stage === 'flop' ? 'turn' : 'river'
    for (const player of round.players) player.bet = 0
    round.currentBet = 0
    round.actionCount = 0
    round.timerDeadline = null
    round.turnIndex = null

    for (const player of round.players) {
      player.pending = !player.folded && !player.allIn && player.chips > 0
    }
    round.turnIndex = this.nextEligible(
      round,
      (round.dealerIndex + 1) % round.players.length,
      (player) => player.pending,
    )
  }

  private dealBoard(round: RoundState): void {
    const count = round.board.length === 0 ? 3 : 1
    for (let i = 0; i < count && round.deck.length > 0; i++) {
      round.board.push(round.deck.shift() as Card)
    }
  }

  private async onTimeout(chatId: number): Promise<void> {
    const round = this.store.getActiveRound(chatId)
    if (!round || round.status !== 'active' || round.timerDeadline === null) return
    if (round.timerDeadline > Date.now()) {
      this.scheduleTimer(round)
      return
    }

    for (const player of round.players) {
      if (player.pending && !player.folded) {
        player.folded = true
        player.pending = false
      }
    }
    round.turnIndex = null
    await this.advanceStreet(round)
    this.store.saveRound(round)
    await this.renderAll(round)
  }

  private settle(round: RoundState): void {
    const contenders = round.players.filter((player) => !player.folded)
    const payouts = new Map<number, number>()
    const refunded = contenders.length === 0

    if (refunded) {
      for (const player of round.players) payouts.set(player.userId, player.committed)
    } else if (contenders.length === 1) {
      payouts.set(contenders[0].userId, potOf(round))
    } else {
      const levels = [...new Set(round.players.map((player) => player.committed).filter((amount) => amount > 0))]
        .sort((a, b) => a - b)
      let previous = 0
      let leftover = 0

      for (const level of levels) {
        let pot = 0
        for (const player of round.players) {
          pot += Math.max(0, Math.min(player.committed, level) - Math.min(player.committed, previous))
        }
        const eligible = contenders.filter((player) => player.committed >= level)
        if (pot > 0 && eligible.length === 0) leftover += pot
        if (pot > 0 && eligible.length > 0) {
          let best = eligible[0]
          for (const player of eligible) {
            if (compareHands([...player.cards, ...round.board], [...best.cards, ...round.board]) > 0) best = player
          }
          const winners = eligible.filter((player) =>
            compareHands([...player.cards, ...round.board], [...best.cards, ...round.board]) === 0)
          const share = Math.floor(pot / winners.length)
          let remainder = pot - share * winners.length
          for (const winner of winners) {
            const amount = share + (remainder > 0 ? 1 : 0)
            remainder = Math.max(0, remainder - 1)
            payouts.set(winner.userId, (payouts.get(winner.userId) ?? 0) + amount)
          }
        }
        previous = level
      }

      if (leftover > 0 && contenders.length > 0) {
        let best = contenders[0]
        for (const player of contenders) {
          if (compareHands([...player.cards, ...round.board], [...best.cards, ...round.board]) > 0) best = player
        }
        payouts.set(best.userId, (payouts.get(best.userId) ?? 0) + leftover)
      }
    }

    for (const player of round.players) {
      this.store.setChips(round.chatId, player.userId, player.chips + (payouts.get(player.userId) ?? 0))
      player.pending = false
    }

    const summary = [...payouts.entries()]
      .map(([userId, amount]) => {
        const player = round.players.find((candidate) => candidate.userId === userId)!
        const hand = contenders.length > 1 ? ` · <i>${handName([...player.cards, ...round.board])}</i>` : ''
        return `${mention(player)} (+${amount} фишек)${hand}`
      })
      .join(', ')

    round.status = 'finished'
    round.turnIndex = null
    round.timerDeadline = null
    round.stage = 'showdown'
    round.result = refunded
      ? `🏁 <b>Раунд завершен!</b>\nВсе спасовали — фишки возвращены: ${summary}\n`
        + `Доска: ${cardsLabel(round.board)}`
      : `🏆 <b>Раунд завершен!</b>\nПобедитель: ${summary}\n`
        + `Доска: ${cardsLabel(round.board)} · Банк: ${potOf(round)}`
    this.clearTimer(round.chatId)
  }

  private scheduleTimer(round: RoundState): void {
    this.clearTimer(round.chatId)
    if (round.status !== 'active' || round.timerDeadline === null) return
    const handle = setTimeout(() => {
      void this.withLock(round.chatId, () => this.onTimeout(round.chatId)).catch((error) => console.error(error))
    }, Math.max(0, round.timerDeadline - Date.now()))
    handle.unref()
    this.timers.set(round.chatId, handle)
  }

  private clearTimer(chatId: number): void {
    const handle = this.timers.get(chatId)
    if (handle) clearTimeout(handle)
    this.timers.delete(chatId)
  }

  private async renderAll(round: RoundState): Promise<void> {
    await this.renderChat(round)
    for (const player of round.players) await this.renderDm(round, player)
    this.store.saveRound(round)
  }

  private chatText(round: RoundState): string {
    if (round.status === 'finished') return round.result ?? 'Раунд завершён.'
    const lines = [
      `🎰 <b>Покер · раунд #${round.roundId}</b>`,
      `Этап: <b>${STAGE_LABELS[round.stage]}</b> · Банк: <b>${potOf(round)}</b> · Ставка: ${round.currentBet}`,
      `Доска: ${cardsLabel(round.board)}`,
      '',
    ]
    if (round.notice) lines.push(round.notice, '')
    lines.push('<b>Участники:</b>')
    for (const [index, player] of round.players.entries()) {
      let status = '⏳ ожидание'
      if (player.folded) status = '❌ пас'
      else if (player.allIn) status = '🔒 all-in'
      else if (round.turnIndex === index) status = '🎯 ход'
      lines.push(`${index + 1}. ${mention(player)} — ${player.chips} фишек · ставка ${player.bet} · ${status}`)
    }
    const actor = round.turnIndex === null ? null : round.players[round.turnIndex]
    if (actor) lines.push('', `🔥 Ход: ${mention(actor)}`)
    if (round.timerDeadline !== null) {
      const seconds = Math.max(0, Math.ceil((round.timerDeadline - Date.now()) / 1000))
      lines.push(`⏱ Автопас не ответивших через ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)
    }
    return lines.join('\n')
  }

  private dmText(round: RoundState, player: PlayerState): string {
    const lines = [
      `🃏 <b>Покер · раунд #${round.roundId}</b> · ${escapeHtml(round.chatTitle)}`,
      `Ваши карты: <b>${cardsLabel(player.cards)}</b>`,
      `Банк: ${potOf(round)} · Ставка: ${round.currentBet} · Ваша ставка: ${player.bet}`,
      `Доска: ${cardsLabel(round.board)}`,
      '',
    ]
    if (round.status === 'finished') {
      lines.push(round.result ?? 'Раунд завершён.')
    } else if (player.folded) {
      lines.push('❌ Вы спасовали. Ждите следующего раунда.')
    } else if (round.turnIndex !== null && round.players[round.turnIndex].userId === player.userId) {
      lines.push('🔥 <b>Ваш ход!</b> Выберите действие ниже.')
    } else if (round.turnIndex !== null) {
      lines.push(`⏳ Ожидаем ход: ${mention(round.players[round.turnIndex])}`)
    } else {
      lines.push('⏳ Переход к следующему этапу...')
    }
    return lines.join('\n')
  }

  private keyboard(round: RoundState, player: PlayerState): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    keyboard.text('🏳 Fold', callbackData(round.chatId, 'fold'))
    if (player.bet === round.currentBet) {
      keyboard.text('✓ Check', callbackData(round.chatId, 'check'))
    } else {
      const amount = Math.min(round.currentBet - player.bet, player.chips)
      keyboard.text(`💵 Call ${amount}`, callbackData(round.chatId, 'call'))
    }
    const target = Math.min(nextRaiseTo(round.currentBet, this.settings.bigBlind), player.bet + player.chips)
    if (target > round.currentBet && player.chips > 0) {
      const label = target >= player.bet + player.chips ? `⬆️ All-in ${target}` : `⬆️ Raise ${target}`
      keyboard.text(label, callbackData(round.chatId, 'raise'))
    }
    return keyboard
  }

  private async renderChat(round: RoundState): Promise<void> {
    const text = this.chatText(round)
    const markup = new InlineKeyboard()
    if (round.status === 'active' && round.notice && this.botUsername) {
      markup.url('Открыть ЛС бота', `https://t.me/${this.botUsername}?start=poker`)
    }
    if (round.chatMessageId !== null) {
      try {
        await this.bot.api.editMessageText(round.chatId, round.chatMessageId, text, {
          parse_mode: 'HTML',
          reply_markup: markup,
        })
        return
      } catch (error) {
        if (!isNotModified(error)) console.error('Cannot edit chat message, sending a new one:', error)
        else return
      }
    }
    const message = await this.bot.api.sendMessage(round.chatId, text, {
      parse_mode: 'HTML',
      reply_markup: markup,
    })
    round.chatMessageId = message.message_id
  }

  private async renderDm(round: RoundState, player: PlayerState): Promise<void> {
    const canAct = round.status === 'active'
      && round.turnIndex !== null
      && round.players[round.turnIndex].userId === player.userId
      && !player.folded
      && player.pending
    const markup = canAct ? this.keyboard(round, player) : new InlineKeyboard()
    const text = this.dmText(round, player)

    if (player.dmMessageId !== null) {
      try {
        await this.bot.api.editMessageText(player.userId, player.dmMessageId, text, {
          parse_mode: 'HTML',
          reply_markup: markup,
        })
        return
      } catch (error) {
        if (isNotModified(error)) return
        console.error(`Cannot edit DM for ${player.userId}:`, error)
      }
    }
    try {
      const message = await this.bot.api.sendMessage(player.userId, text, {
        parse_mode: 'HTML',
        reply_markup: markup,
      })
      player.dmMessageId = message.message_id
    } catch (error) {
      console.error(`Cannot send DM to ${player.userId}:`, error)
      this.store.markDmNotReady(player.userId)
    }
  }
}
