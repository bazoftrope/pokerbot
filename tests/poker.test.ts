import assert from 'node:assert/strict'
import test from 'node:test'
import { bestScore, cardLabel, compareHands, createDeck, nextRaiseTo } from '../src/poker.js'
import type { Card } from '../src/types.js'

function card(rank: number, suit: Card['suit'] = 's'): Card {
  return { rank, suit }
}

test('колода содержит 52 уникальные карты', () => {
  const deck = createDeck()
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck.map((item) => `${item.rank}${item.suit}`)).size, 52)
  assert.equal(cardLabel(card(14, 'h')), 'A♥')
})

test('стрит-флаш старше каре, а каре старше фулл-хауса', () => {
  const straightFlush = [card(14), card(13), card(12), card(11), card(10), card(2, 'h'), card(3, 'd')]
  const quads = [card(9), card(9, 'h'), card(9, 'd'), card(9, 'c'), card(14, 'h'), card(2, 'h'), card(3, 'd')]
  const fullHouse = [card(8), card(8, 'h'), card(8, 'd'), card(4, 'c'), card(4, 'h'), card(2, 'h'), card(3, 'd')]
  assert.ok(compareHands(straightFlush, quads) > 0)
  assert.ok(compareHands(quads, fullHouse) > 0)
  assert.equal(bestScore(straightFlush).category, 8)
})

test('туз может быть младшей картой в стрите', () => {
  const wheel = [card(14), card(2, 'h'), card(3, 'd'), card(4, 'c'), card(5), card(9, 'h'), card(9, 'd')]
  const sixHigh = [card(2), card(3, 'h'), card(4, 'd'), card(5, 'c'), card(6), card(9, 'h'), card(9, 'd')]
  assert.deepEqual(bestScore(wheel), { category: 4, tiebreakers: [5] })
  assert.ok(compareHands(sixHigh, wheel) > 0)
})

test('одинаковые комбинации разных мастей делят банк', () => {
  const first = [card(14), card(13), card(9), card(7, 'h'), card(2, 'd'), card(8, 'c'), card(3, 'h')]
  const second = [card(14, 'h'), card(13, 'h'), card(9, 'h'), card(7), card(2, 'c'), card(8, 'd'), card(3, 'd')]
  assert.equal(compareHands(first, second), 0)
})

test('фиксированный рейз x2 от текущей ставки', () => {
  assert.equal(nextRaiseTo(0, 20), 40)
  assert.equal(nextRaiseTo(20, 20), 40)
  assert.equal(nextRaiseTo(40, 20), 80)
  assert.equal(nextRaiseTo(60, 20), 120)
})
