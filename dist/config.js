import 'dotenv/config';
function intFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got: ${raw}`);
    }
    return value;
}
const token = process.env.BOT_TOKEN?.trim();
if (!token) {
    throw new Error('BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
}
export const config = {
    token,
    dbPath: process.env.DB_PATH?.trim() || './data/poker.sqlite',
    startingChips: intFromEnv('STARTING_CHIPS', 1000),
    smallBlind: intFromEnv('SMALL_BLIND', 10),
    bigBlind: intFromEnv('BIG_BLIND', 20),
    actionTimeoutMs: intFromEnv('ACTION_TIMEOUT_MS', 5 * 60 * 1000),
};
