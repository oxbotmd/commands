/**
 * commands/kick.js
 * Kick a user from group
 * ── PRO FEATURE ── Requires active subscription
 */

const name     = 'kick';
const desc     = 'Kick a user from group (Pro)';
const category = 'group';

// ✅ Robust JID cleaner
function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ PRO PLAN CHECKERS ★
// ═══════════════════════════════════════════════════════════════════════════════

async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query(
            'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };

        // Fallback to oxbot_ prefix (fixes dashboard/bot data mismatch)
        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        }
        return null;
    } catch (err) {
        console.error('[kick] getOwnerUserId error:', err.message);
        return null;
    }
}

async function isProUser(db, userId) {
    if (!userId) return false;
    try {
        const [rows] = await db.query(
            `SELECT id FROM pro_subscriptions WHERE user_id=? AND status='active' AND expires_at > NOW() LIMIT 1`,
            [userId]
        );
        return rows.length > 0;
    } catch (err) {
        console.error('[kick] isProUser error:', err.message);
        return false;
    }
}

/**
 * Blocks free users and sends upgrade message
 * @returns {boolean} true = blocked, false = allowed
 */
async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false; // Dev mode — allow

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId    = ownerData?.userId;
    const proOn     = await isProUser(db, userId);

    if (!proOn) {
        await sock.sendMessage(chatId, {
            text: '👑 *Pro Plan Required*\n\n_Kick is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true; // BLOCKED
    }
    return false; // ALLOWED
}

// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    // ── ★ PRO CHECK — blocks free users immediately ★ ─────────────────────────
    if (await blockIfFree(sock, chatId, msg, botData?.db, botData?.sessionId)) {
        return null;
    }

    const senderId = msg.key.participant || chatId;
    
    // 1. Fast owner check using socket identity
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum = cleanNum(senderId);
        const ownerNum  = ownerPhone ? cleanNum(ownerPhone) : '';
        
        if (senderNum && ownerNum) {
            const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oNorm = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            senderIsOwner = sNorm === oNorm || sNorm.endsWith(oNorm) || oNorm.endsWith(sNorm);
        }
    }

    // 2. If NOT the owner, check if sender is a Group Admin
    if (!msg.key.fromMe && !senderIsOwner) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const senderNum = cleanNum(senderId);
            const senderIsAdmin = meta.participants?.some(p => 
                cleanNum(p.id) === senderNum && 
                (p.admin === 'admin' || p.admin === 'superadmin')
            );

            if (!senderIsAdmin) {
                return await sock.sendMessage(chatId, { text: '❌ Only admins can use this!' }, { quoted: msg });
            }
        } catch {
            return await sock.sendMessage(chatId, { text: '❌ Could not fetch group info.' }, { quoted: msg });
        }
    }

    // 3. Extract target users (Mentions or Reply)
    let targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (!targets.length && msg.message?.extendedTextMessage?.contextInfo?.participant) {
        targets = [msg.message.extendedTextMessage.contextInfo.participant];
    }
    
    if (!targets.length) {
        return await sock.sendMessage(chatId, { text: '❌ Mention or reply to a user!\n_*.kick @user*_' }, { quoted: msg });
    }

    // 4. ATTEMPT TO KICK (Bypasses Baileys cache bug!)
    try {
        await sock.groupParticipantsUpdate(chatId, targets, 'remove');
        
        const names = targets.map(j => `@${j.split('@')[0]}`).join(', ');
        await sock.sendMessage(chatId, {
            text: `🚫 *Kicked:* ${names}\n👑 *By:* @${cleanNum(senderId)}`,
            mentions: [...targets, senderId]
        }, { quoted: msg });
    } catch (err) {
        // If WhatsApp rejects it, it means the bot is truly not an admin
        if (err?.message?.includes('not-admin') || err?.output?.statusCode === 400) {
            await sock.sendMessage(chatId, { 
                text: '❌ *Action failed:* I need to be an admin to kick members.\n\n_⚠️ If you just made me admin, please REMOVE me from the group and ADD me back in to fix this bug._' 
            }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Failed to kick: ${err.message}` }, { quoted: msg });
        }
    }
}

module.exports = { name, desc, category, execute };
