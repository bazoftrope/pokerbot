import http from 'node:http'
import { Bot, InlineKeyboard } from 'grammy'
import { config } from './config.js'
import { PokerGame } from './game.js'
import { Store } from './store.js'

const port = Number(process.env.PORT ?? 3000)
const healthServer = http.createServer((request, response) => {
  response.writeHead(request.url === '/health' || request.url === '/' ? 200 : 404, { 'Content-Type': 'text/plain' })
  response.end(request.url === '/health' || request.url === '/' ? 'OK' : 'Not found')
})
healthServer.listen(port, '0.0.0.0', () => console.log(`Health check available on port ${port}`))

const store = new Store(config.dbPath, config.startingChips)
const bot = new Bot(config.token)
let botUsername = ''
try {
  botUsername = (await bot.api.getMe()).username ?? ''
} catch (error) {
  console.error('Cannot get bot info:', error)
}
const dmLink = `https://t.me/${botUsername}?start=poker`
const game = new PokerGame(bot, store, config, botUsername)

bot.command('start', async (ctx) => {
  const user = ctx.from
  if (ctx.chat?.type !== 'private' || !user) {
    await ctx.reply('Напиши мне личные сообщения и отправь /start — тогда я смогу раздавать тебе карты.')
    return
  }
  store.markDmReady(user)
  const active = store.getActiveRounds().find((round) => round.players.some((player) => player.userId === user.id))
  const late = active
    ? `\nСейчас идёт раунд #${active.roundId} — вы в нём не участвуете. В следующем раунде карты придут автоматически.`
    : ''
  await ctx.reply(
    ctx.match === 'poker'
      ? `Готово! Теперь я буду автоматически присылать вам карты.${late}`
      : `Готово! Теперь в группе друзей можно играть в покер.${late}`,
  )
})

bot.command('poker', async (ctx) => {
  const chat = ctx.chat
  if (!chat || chat.type === 'private') {
    await ctx.reply('Команда /poker работает в групповом чате.')
    return
  }
  if (ctx.from) store.registerPlayer(chat.id, ctx.from)
  await game.startRound(chat.id, chat.title || 'чате друзей')
})

bot.command('players', async (ctx) => {
  const chat = ctx.chat
  if (!chat || chat.type === 'private') {
    await ctx.reply('Команда /players работает в групповом чате.')
    return
  }
  const players = store.getPlayers(chat.id)
  if (players.length === 0) {
    await ctx.reply('В этом чате пока нет игроков. Напиши /poker, чтобы зарегистрироваться.')
    return
  }
  const lines = players.map((player) => {
    const name = player.username ? `@${player.username}` : player.firstName
    const status = player.dmReady ? 'ЛС готово' : 'нужен /start в ЛС'
    return `• ${name} — ${player.chips} фишек (${status})`
  })
  const markup = new InlineKeyboard()
  if (botUsername && players.some((player) => !player.dmReady)) {
    markup.url('Открыть ЛС бота', dmLink)
  }
  await ctx.reply(`Игроки чата:\n${lines.join('\n')}`, { reply_markup: markup })
})

bot.on('message', async (ctx) => {
  const chat = ctx.chat
  if (chat && (chat.type === 'group' || chat.type === 'supergroup') && ctx.from) {
    store.registerPlayer(chat.id, ctx.from)
  }
})

bot.on('callback_query:data', async (ctx) => {
  const parts = ctx.callbackQuery.data.split(':')
  if (parts[0] !== 'pk' || parts.length !== 3) {
    await ctx.answerCallbackQuery()
    return
  }
  await ctx.answerCallbackQuery()
  if (ctx.chat?.type !== 'private' || !ctx.from) return
  const chatId = Number(parts[1])
  if (!Number.isSafeInteger(chatId)) return
  await game.handleAction(chatId, ctx.from.id, parts[2])
})

bot.catch((error) => {
  console.error('Bot error:', error)
})

try {
  await game.restoreTimers()
  await bot.start({ onStart: () => console.log(`@${botUsername} запущен`) })
} catch (error) {
  console.error('Fatal startup error:', error)
  process.exitCode = 1
}

function shutdown(): void {
  bot.stop()
  healthServer.close()
  store.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
