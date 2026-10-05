/**
 * commands/game.js — OxBot Gamble / Guess Game (Owner Only)
 * Aliases: .game, .gamble, .bet, .guess
 * 
 * Pay 20 coins to guess a number between 1-100.
 * Win = 40 coins (2x). Lose = lose your 20 coins.
 * Win rate is exactly 1% to drain coins fast.
 */

const name     = 'game';
const desc     = 'Bet 20 coins to win 40 (1% chance)';
const category = 'owner';
const aliases  = ['gamble', 'bet', 'guess'];

const BET_AMOUNT   = 20;
const REWARD_AMOUNT = 40;
const MIN_NUM = 1;
const MAX_NUM = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// ★ OWNER VERIFICATION (Prevents opponents from playing) ★
// ═══════════════════════════════════════════════════════════════════════════════

function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[game] DB error fetching owner:', err.message);
        return null;
    }
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid) return true;
    if (senderClean === ownerNumber) return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata     = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];
            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });
            if (match) return true;
        } catch {}
    }
    return false;
}

async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query(
            'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return { userId: rows[0].user_id };

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id };
        }
        return null;
    } catch (err) {
        console.error('[game] getOwnerUserId error:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db = botData?.db || sock?._botData?.db;
    const sessionId = botData?.sessionId || sock?._botData?.sessionId;
    const senderId = msg.key.participant || msg.key.remoteJid;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    // ── STEP 1: STRICT OWNER CHECK ─────────────────────────────────────────
    if (!msg.key.fromMe && !await isOwner(db, sessionId, senderId, sock, chatId)) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Access Denied!*\n\n_Only the bot owner can play this game._'
        }, { quoted: msg });
    }

    // ── STEP 2: VALIDATE GUESS ─────────────────────────────────────────────
    const guessStr = (args[0] || '').trim();
    const guess = parseInt(guessStr, 10);

    if (!guessStr || isNaN(guess)) {
        return await sock.sendMessage(chatId, {
            text: `🎰 *COIN FLIP / GUESS GAME*\n\n_Pay ${BET_AMOUNT} coins to guess a number.\nIf you guess right, you win ${REWARD_AMOUNT} coins!_\n\n⚠️ *Warning:* 1 in ${MAX_NUM} chance (1%). It is extremely hard.\n\n_Usage: .game <number>_ \n_Example: .game 42_`
        }, { quoted: msg });
    }

    if (guess < MIN_NUM || guess > MAX_NUM) {
        return await sock.sendMessage(chatId, {
            text: `❌ Invalid number! You must guess between *${MIN_NUM}* and *${MAX_NUM}*.`
        }, { quoted: msg });
    }

    // ── STEP 3: GET USER & CHECK BALANCE ──────────────────────────────────
    const ownerData = await getOwnerUserId(db, sessionId);
    if (!ownerData?.userId) {
        return await sock.sendMessage(chatId, { text: '❌ Could not verify account.' }, { quoted: msg });
    }

    const userId = ownerData.userId;
    const [userRows] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
    
    if (!userRows.length) {
        return await sock.sendMessage(chatId, { text: '❌ User not found.' }, { quoted: msg });
    }

    const currentBalance = userRows[0].balance || 0;

    if (currentBalance < BET_AMOUNT) {
        return await sock.sendMessage(chatId, {
            text: `💸 *Insufficient Funds!*\n\nYou need *${BET_AMOUNT} coins* to play, but you only have *${currentBalance} coins*.\n\n_Use .daily to claim more coins._`
        }, { quoted: msg });
    }

    // ── STEP 4: DEDUCT BET IMMEDIATELY ────────────────────────────────────
    try {
        await db.query(
            'UPDATE users SET balance = balance - ? WHERE id = ?',
            [BET_AMOUNT, userId]
        );
    } catch (err) {
        console.error('[game] DB deduct error:', err.message);
        return await sock.sendMessage(chatId, { text: '❌ Transaction failed.' }, { quoted: msg });
    }

    // ── STEP 5: GENERATE RANDOM NUMBER & COMPARE ──────────────────────────
    const secretNumber = Math.floor(Math.random() * MAX_NUM) + 1;
    const isWin = (guess === secretNumber);

    let responseText = '';

    if (isWin) {
        // WIN: Give them their reward
        try {
            await db.query(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [REWARD_AMOUNT, userId]
            );
        } catch (err) {
            console.error('[game] DB reward error:', err.message);
        }

        const [newBal] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);

        responseText = (
            `🎉 *UNBELIEVABLE!!! YOU WON!* 🎉\n\n` +
            `🃏 *Your Guess:* ${guess}\n` +
            `🎯 *Secret Number:* ${secretNumber}\n\n` +
            `💰 *Prize:* +${REWARD_AMOUNT} Coins\n` +
            `🏦 *New Balance:* ${newBal[0]?.balance || 0} Coins\n\n` +
            `_(You literally just hit a 1% chance. Don't push your luck.)_`
        );
    } else {
        // LOSE
        const newBal = currentBalance - BET_AMOUNT;

        // Add some trash talk to make it funny when they lose
        let roast = '';
        if (secretNumber - guess <= 3 && secretNumber - guess > 0) roast = '_So close, yet so far!_ 💀';
        else if (guess - secretNumber <= 3 && guess - secretNumber > 0) roast = '_You were literally touching it!_ 😂';
        else if (guess > 80 || guess < 20) roast = `_Did you really think ${guess} would work?_ 🤡`;
        else roast = `_Better luck next time!_ 🗑️`;

        responseText = (
            `💀 *BUSTED!* 💀\n\n` +
            `🃏 *Your Guess:* ${guess}\n` +
            `🎯 *Secret Number:* ${secretNumber}\n\n` +
            `💸 *Lost:* -${BET_AMOUNT} Coins\n` +
            `🏦 *Remaining Balance:* ${newBal} Coins\n\n` +
            `${roast}`
        );
    }

    await sock.sendMessage(chatId, { text: responseText }, { quoted: msg });
    return null;
}

module.exports = { name, desc, category, aliases, execute };
