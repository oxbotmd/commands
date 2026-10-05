/**
 * vv2.js — View Once Revealer (Public Chat Version)
 * Aliases: .vv2, .reveal, .openvv
 * 
 * Reveals view-once media directly in the chat for everyone to see.
 * ── PRO FEATURE ── Free Trial users are redirected to use .vv
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

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
        console.error('[vv2] getOwnerUserId error:', err.message);
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
        console.error('[vv2] isProUser error:', err.message);
        return false;
    }
}

/**
 * Blocks free users and sends upgrade message pointing to .vv
 * @returns {boolean} true = blocked, false = allowed
 */
async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false; // Dev mode — allow

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId    = ownerData?.userId;
    const proOn     = await isProUser(db, userId);

    if (!proOn) {
        await sock.sendMessage(chatId, {
            text: '👑 *Pro Plan Required*\n\n_Revealing view-once media directly in the group chat is a premium feature._\n\n_📖 Free Trial users can use *.vv* instead._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true; // BLOCKED
    }
    return false; // ALLOWED
}

// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // ── ★ PRO CHECK — blocks free users immediately ★ ─────────
    if (await blockIfFree(sock, chatId, msg, botData?.db, botData?.sessionId)) {
        return null; // Don't delete the command so the user sees the upgrade message
    }

    // ── 1. Get Media from Quoted Message ─────────────────────
    const quoted      = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedImage = quoted?.imageMessage;
    const quotedVideo = quoted?.videoMessage;

    const isViewOnceImage = quotedImage && quotedImage.viewOnce;
    const isViewOnceVideo = quotedVideo && quotedVideo.viewOnce;

    if (!isViewOnceImage && !isViewOnceVideo) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Please reply to a view-once image or video with `.vv2`'
        }, { quoted: msg });
        return null;
    }

    // ── 2. DELETE the .vv2 command message immediately ───────
    //    This makes it look seamless in the chat
    await sock.sendMessage(chatId, { delete: msg.key }).catch(() => {});

    // ── 3. Download the media ────────────────────────────────
    try {
        let buffer, type;
        let originalCaption = '';

        if (isViewOnceImage) {
            const stream = await downloadContentFromMessage(quotedImage, 'image');
            buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            type = 'image';
            originalCaption = quotedImage.caption || '';
        } else {
            const stream = await downloadContentFromMessage(quotedVideo, 'video');
            buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            type = 'video';
            originalCaption = quotedVideo.caption || '';
        }

        // ── 4. Send back to the SAME chat ────────────────────
        const sendText = originalCaption ? `🔓 *View-Once Revealed*\n\n${originalCaption}` : '🔓 *View-Once Revealed*';

        if (type === 'image') {
            await sock.sendMessage(chatId, {
                image: buffer,
                caption: sendText
            });
        } else if (type === 'video') {
            await sock.sendMessage(chatId, {
                video: buffer,
                caption: sendText
            });
        }

        return null;

    } catch (err) {
        console.error('[vv2] Download error:', err.message);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to process view-once media. The media might have expired.'
        }).catch(() => {});
        return null;
    }
}

module.exports = {
    name:     'vv2',
    aliases:  ['reveal', 'openvv'],
    desc:     'Reveal view-once media in the chat (Pro)',
    category: 'general',
    execute
};
