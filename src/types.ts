export type Suit = 's' | 'h' | 'd' | 'c'

export interface Card {
  rank: number
  suit: Suit
}

export type Stage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type Action = 'fold' | 'check' | 'call' | 'raise'

export interface PlayerState {
  userId: number
  username: string | null
  firstName: string
  cards: [Card, Card]
  bet: number
  committed: number
  chips: number
  folded: boolean
  allIn: boolean
  pending: boolean
  dmMessageId: number | null
}

export interface RoundState {
  chatId: number
  chatTitle: string
  notice: string | null
  roundId: number
  status: 'active' | 'finished'
  stage: Stage
  board: Card[]
  deck: Card[]
  players: PlayerState[]
  dealerIndex: number
  turnIndex: number | null
  currentBet: number
  actionCount: number
  timerThreshold: number
  timerDeadline: number | null
  chatMessageId: number | null
  result: string | null
  createdAt: number
}

export interface ChatPlayer {
  userId: number
  username: string | null
  firstName: string
  chips: number
  dmReady: boolean
}

export interface Config {
  token: string
  dbPath: string
  startingChips: number
  smallBlind: number
  bigBlind: number
  actionTimeoutMs: number
}
