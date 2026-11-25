import type { Card, Suit } from './types.js'

const SUITS: Suit[] = ['s', 'h', 'd', 'c']
const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
const RANK_LABEL: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
const CATEGORY_NAMES = [
  'старшая карта', 'пара', 'две пары', 'триплет', 'стрит',
  'флаш', 'фулл-хаус', 'каре', 'стрит-флаш',
]

export interface HandScore {
  category: number
  tiebreakers: number[]
}

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit })
  }
  return deck
}

export function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function rankLabel(rank: number): string {
  return RANK_LABEL[rank] ?? String(rank)
}

export function cardLabel(card: Card): string {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`
}

export function cardsLabel(cards: Card[]): string {
  return cards.length ? cards.map(cardLabel).join(' ') : '—'
}

export function compareScore(a: HandScore, b: HandScore): number {
  if (a.category !== b.category) return a.category - b.category
  const length = Math.max(a.tiebreakers.length, b.tiebreakers.length)
  for (let i = 0; i < length; i++) {
    const diff = (a.tiebreakers[i] ?? 0) - (b.tiebreakers[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function evaluateFive(cards: Card[]): HandScore {
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a)
  const suits = cards.map((card) => card.suit)
  const isFlush = suits.every((suit) => suit === suits[0])
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a)

  let straightHigh = 0
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) straightHigh = uniqueRanks[0]
    else if (uniqueRanks.join(',') === '14,5,4,3,2') straightHigh = 5
  }

  const counts = new Map<number, number>()
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const groupSizes = groups.map((group) => group[1])

  if (isFlush && straightHigh) return { category: 8, tiebreakers: [straightHigh] }
  if (groupSizes[0] === 4) return { category: 7, tiebreakers: [groups[0][0], groups[1][0]] }
  if (groupSizes[0] === 3 && groupSizes[1] === 2) return { category: 6, tiebreakers: [groups[0][0], groups[1][0]] }
  if (isFlush) return { category: 5, tiebreakers: ranks }
  if (straightHigh) return { category: 4, tiebreakers: [straightHigh] }
  if (groupSizes[0] === 3) return { category: 3, tiebreakers: [groups[0][0], groups[1][0], groups[2][0]] }
  if (groupSizes[0] === 2 && groupSizes[1] === 2) {
    return { category: 2, tiebreakers: [groups[0][0], groups[1][0], groups[2][0]] }
  }
  if (groupSizes[0] === 2) {
    return { category: 1, tiebreakers: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]] }
  }
  return { category: 0, tiebreakers: ranks }
}

export function bestScore(cards: Card[]): HandScore {
  let best: HandScore | null = null
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const score = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]])
            if (best === null || compareScore(score, best) > 0) best = score
          }
        }
      }
    }
  }
  if (best === null) throw new Error('At least 5 cards are required')
  return best
}

export function compareHands(a: Card[], b: Card[]): number {
  return compareScore(bestScore(a), bestScore(b))
}

export function handName(cards: Card[]): string {
  return CATEGORY_NAMES[bestScore(cards).category] ?? 'комбинация'
}

export function nextRaiseTo(currentBet: number, bigBlind: number): number {
  return currentBet === 0 ? bigBlind * 2 : Math.max(currentBet * 2, currentBet + bigBlind)
}
