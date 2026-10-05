/**
 * commands/alive.js
 * Check if bot is running
 */

const version = '3.1.0';
const channelLink = 'https://whatsapp.com/channel/0029VaZJW9qLikl6KhJPcs2B';

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

async function execute(sock, msg, botData, args) {
    try {
        const chatId = msg.key.remoteJid;
        if (!chatId) return null;

        // Get owner number for button
        let ownerNumber = '';
        try {
            const db = botData?.db;
            const sessionId = botData?.sessionId;
            if (db && sessionId) {
                const [rows] = await db.query(
                    'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
                    [sessionId]
                );
                if (rows.length && rows[0].phone) {
                    ownerNumber = String(rows[0].phone).replace(/\D/g, '');
                }
            }
        } catch {}

        const uptime = formatUptime(process.uptime());

        const bodyText = `┏━━━━━━━━━━━━━━━━━━━━━┓
┃   🤖 *OxBot Is Alive*   ┃
┗━━━━━━━━━━━━━━━━━━━━━┛

┌──────────────────────┐
│ ✅ Status   : *Online*
│ 📦 Version  : *v${version}*
│ ⏱️ Uptime   : *${uptime}*
└──────────────────────┘

💡 Type *.menu* for all commands`;

        // ✅ FIXED: templateButtons is WhatsApp's deprecated button format —
        // it often silently fails to render on current multi-device clients.
        // interactiveButtons (native flow, cta_url type) is the modern
        // equivalent for "tap to open a link" buttons.
        try {
            await sock.sendMessage(chatId, {
                text: bodyText,
                footer: '🤖 OxBot',
                interactiveButtons: [
                    {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                            display_text: '📌 View Channel',
                            url: channelLink,
                            merchant_url: channelLink,
                        }),
                    },
                    {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                            display_text: '👑 Owner',
                            url: `https://wa.me/${ownerNumber || '2348000000000'}`,
                            merchant_url: `https://wa.me/${ownerNumber || '2348000000000'}`,
                        }),
                    },
                ],
            }, { quoted: msg });
        } catch (btnErr) {
            // Fallback: plain text with links inline if buttons aren't
            // supported on this Baileys/WhatsApp version
            console.error('[alive] Interactive buttons failed, falling back to plain text:', btnErr.message);
            await sock.sendMessage(chatId, {
                text: `${bodyText}\n\n📌 Channel: ${channelLink}\n👑 Owner: https://wa.me/${ownerNumber || '2348000000000'}`,
            }, { quoted: msg });
        }

        return null;
    } catch (error) {
        console.error('Error in alive command:', error.message);
        return '❌ Failed.';
    }
}

module.exports = {
    name: 'alive',
    desc: 'Check if bot is online',
    category: 'general',
    execute: execute
};
