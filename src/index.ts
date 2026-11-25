import { Bot } from 'grammy'
import { config } from './config.js'
import { PokerGame } from './game.js'
import { Store } from './store.js'

const store = new Store(config.dbPath, config.startingChips)
const bot = new Bot(config.token)
const game = new PokerGame(bot, store, config)

bot.command('start', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !ctx.from) {
    await ctx.reply('Напиши мне личные сообщения и отправь /start — тогда я смогу раздавать тебе карты.')
    return
  }
  store.markDmReady(ctx.from)
  await ctx.reply(
    'Готово! Теперь в группе друзей можно играть в покер.\n'
    + 'Добавь бота в чат, напиши /start каждому игроку, а затем запусти раунд командой /poker.',
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
  await ctx.reply(`Игроки чата:\n${lines.join('\n')}`)
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

await game.restoreTimers()
await bot.start({ onStart: (me) => console.log(`@${me.username} запущен`) })

function shutdown(): void {
  bot.stop()
  store.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
