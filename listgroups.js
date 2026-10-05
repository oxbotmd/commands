/**
 * commands/listgroups.js
 * List every group the bot account is currently in — owner only.
 * Useful for auditing before a mass .broadcast or checking bot reach.
 */

const name     = 'listgroups';
const desc     = 'List all groups the bot is currently in';
const category = 'owner';
const aliases  = ['groups', 'mygroups'];

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const senderId = msg.key.participant || chatId;

    // Owner-only — this exposes every group the bot has access to,
    // same trust level as .setprofilename / .broadcast.
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum  = cleanNum(senderId);
        const ownerNum   = ownerPhone ? cleanNum(ownerPhone) : '';

        if (senderNum && ownerNum) {
            const sN = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oN = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            senderIsOwner = sN === oN || sN.endsWith(oN) || oN.endsWith(sN);
        }
    }

    if (!senderIsOwner) {
        return await sock.sendMessage(chatId, { text: '❌ Only the bot owner can use this.' }, { quoted: msg });
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}

    try {
        const allGroups = await sock.groupFetchAllParticipating();
        const groups = Object.values(allGroups || {});

        if (!groups.length) {
            return await sock.sendMessage(chatId, { text: '📭 This bot is not in any groups yet.' }, { quoted: msg });
        }

        // Sort: groups where the bot is admin first, then by member count desc
        const botId = cleanNum(sock.user?.id?.split(':')[0]);

        const enriched = groups.map(g => {
            const participants = g.participants || [];
            const me = participants.find(p => cleanNum(p.id) === botId);
            const botIsAdmin = me?.admin === 'admin' || me?.admin === 'superadmin';
            return {
                id: g.id,
                subject: g.subject || 'Untitled Group',
                size: participants.length,
                botIsAdmin,
            };
        });

        enriched.sort((a, b) => {
            if (a.botIsAdmin !== b.botIsAdmin) return a.botIsAdmin ? -1 : 1;
            return b.size - a.size;
        });

        const adminCount = enriched.filter(g => g.botIsAdmin).length;

        let text = `👥 *Groups (${enriched.length})*\n`;
        text += `🛡️ Bot is admin in: ${adminCount}/${enriched.length}\n`;
        text += `━━━━━━━━━━━━━━━━━━━\n\n`;

        enriched.forEach((g, i) => {
            const badge = g.botIsAdmin ? '🛡️' : '👤';
            text += `${i + 1}. ${badge} *${g.subject}*\n`;
            text += `   👥 ${g.size} members\n`;
            text += `   🆔 ${g.id}\n\n`;
        });

        text += `━━━━━━━━━━━━━━━━━━━\n`;
        text += `🛡️ = bot is admin  |  👤 = member only`;

        // WhatsApp text messages have practical size limits — split if huge
        if (text.length > 4000) {
            const chunks = [];
            let chunk = '';
            for (const line of text.split('\n')) {
                if ((chunk + line + '\n').length > 4000) {
                    chunks.push(chunk);
                    chunk = '';
                }
                chunk += line + '\n';
            }
            if (chunk) chunks.push(chunk);

            for (const c of chunks) {
                await sock.sendMessage(chatId, { text: c }, { quoted: msg });
            }
        } else {
            await sock.sendMessage(chatId, { text }, { quoted: msg });
        }

        return null;

    } catch (err) {
        console.error('[LISTGROUPS] Error:', err.message);
        return await sock.sendMessage(chatId, { text: `❌ Failed to fetch groups: ${err.message}` }, { quoted: msg });
    }
}

module.exports = { name, desc, category, aliases, execute };