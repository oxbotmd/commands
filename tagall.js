/**
 * commands/tagall.js
 * Tag all members in a group
 * ── PRO FEATURE & ADMIN ONLY ── Requires active subscription and Group Admin rights
 */

const name     = 'tagall';
const desc     = 'Tag all members in a group (Admin & Pro)';
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
        console.error('[tagall] getOwnerUserId error:', err.message);
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
        console.error('[tagall] isProUser error:', err.message);
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
            text: '👑 *Pro Plan Required*\n\n_Tagall is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
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
        return await sock.sendMessage(chatId, { text: '❌ Group only!' }, { quoted: msg });
    }

    // ── ★ PRO CHECK — blocks free users immediately ★ ─────────
    if (await blockIfFree(sock, chatId, msg, botData?.db, botData?.sessionId)) {
        return null;
    }

    const senderId = msg.key.participant || chatId;

    // ── STEP 1: Fast owner check using socket identity ─────────
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum  = cleanNum(senderId);
        const ownerNum   = ownerPhone ? cleanNum(ownerPhone) : '';
        
        if (senderNum && ownerNum) {
            const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oNorm = ownerNum.startsWith('0')  ? ownerNum.slice(1)  : ownerNum;
            senderIsOwner = sNorm === oNorm || sNorm.endsWith(oNorm) || oNorm.endsWith(sNorm);
        }
    }

    try {
        // Fetch group metadata
        const meta = await sock.groupMetadata(chatId);
        const participants = meta.participants || [];
        
        // ── STEP 2: If NOT owner, verify sender is a Group Admin ──
        if (!msg.key.fromMe && !senderIsOwner) {
            const senderNum     = cleanNum(senderId);
            const senderIsAdmin = participants.some(p => {
                const pNum  = cleanNum(p.id);
                const sNorm = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
                const pNorm = pNum.startsWith('0')      ? pNum.slice(1)      : pNum;
                return (pNorm === sNorm || pNorm.endsWith(sNorm) || sNorm.endsWith(pNorm))
                    && (p.admin === 'admin' || p.admin === 'superadmin');
            });

            if (!senderIsAdmin) {
                return await sock.sendMessage(chatId, { text: '❌ Only group admins can use *.tagall*!' }, { quoted: msg });
            }
        }
        
        if (participants.length === 0) {
            return await sock.sendMessage(chatId, { text: '❌ Could not find any members in this group.' }, { quoted: msg });
        }

        const customMsg = args.join(' ').trim() || 'Attention everyone!';
        const senderNum = (msg.key.participant || msg.key.remoteJid).split('@')[0];

        // ═══════════════════════════════════════
        // ★ BUILD CLEAN FORMATTED TEXT ★
        // ═══════════════════════════════════════
        let text = `╭━━━【 *${customMsg}* 】━━━╮\n`;
        text += `│ 👥 *Total Members: ${participants.length}*\n`;
        text += `│ 📢 *By: @${senderNum}*\n`;
        text += `│\n`;
        
        participants.forEach(p => {
            text += `│ ➤ @${p.id.split('@')[0]}\n`;
        });
        
        text += `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`;

        // Get exact JIDs for mentions (Baileys handles @lid automatically)
        const mentions = participants.map(p => p.id);

        await sock.sendMessage(chatId, {
            text,
            mentions
        }, { quoted: msg });

    } catch (error) {
        console.error('[TAGALL] Error:', error.message);
        await sock.sendMessage(chatId, { text: '❌ Failed to fetch group members.' }, { quoted: msg });
    }

    return null;
}

module.exports = { name, desc, category, execute };
