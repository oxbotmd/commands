/**
 * commands/mode.js
 *
 * FIXED: getRealSessionId() in index.js was reading a DIFFERENT session id
 * than this file saves with (bare phone digits vs the canonical
 * "oxbot_<phone>" botData.sessionId). That meant .mode private always
 * wrote to a row that was never found again on read, so getModeForSocket()
 * silently fell back to 'public' forever — the private gate never
 * actually triggered. Root-cause fix is in index.js's getRealSessionId
 * (now prefers botData.sessionId). This file also now exports
 * `canUseBot()` so the actual public/private decision lives here instead
 * of being duplicated inline in index.js.
 */

async function canUseBot(sock, msg, botData) {
    const chatId = msg.key.remoteJid;
    const fromMe = msg.key.fromMe === true;

    // Messages sent from the linked device itself always pass.
    if (fromMe) return true;

    const mode = await botData.getModeForSocket(sock);
    if (mode !== 'private') return true;

    // Resolve sender the same way the rest of the handler does.
    const isGroup = chatId?.endsWith('@g.us');
    const sender  = isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid;

    return await botData.isOwnerAsync(sock, sender, chatId, fromMe);
}

module.exports = {
    name: 'mode',
    desc: 'Change bot mode (public/private)',
    category: 'owner',

    canUseBot,

    async execute(sock, msg, botData, args) {
        const chatId = msg.key.remoteJid;
        const fromMe = msg.key.fromMe === true;

        // Resolve sender correctly for DMs and Groups
        const isGroup = chatId?.endsWith('@g.us');
        let sender;
        if (isGroup) {
            sender = msg.key.participant || msg.key.remoteJid;
        } else if (fromMe) {
            sender = sock.user?.id || msg.key.remoteJid;
        } else {
            sender = msg.key.remoteJid;
        }

        // Check if user is owner/sudo
        const isOwner = await botData.isOwnerAsync(sock, sender, chatId, fromMe);
        if (!isOwner) return;

        const action = args[0]?.toLowerCase();

        // No argument — show current mode
        if (!['public', 'private'].includes(action)) {
            const cur = await botData.getModeForSocket(sock);
            await sock.sendMessage(chatId, {
                text:
                    `*Bot Mode*\n\n` +
                    `Current: *${cur.toUpperCase()}*\n\n` +
                    `Usage:\n- \`.mode public\`\n- \`.mode private\``
            }, { quoted: msg });
            return;
        }

        // Save to database — botData.sessionId is the canonical key
        // (e.g. "oxbot_2348031234567") used everywhere else (bot_settings,
        // bots, paired_sessions). Do NOT fall back to sock._ownerPhone
        // here — that's a different, non-canonical value and is exactly
        // what caused this bug.
        const db = botData.db;
        const realSessionId = botData.sessionId;

        if (!realSessionId) {
            await sock.sendMessage(chatId, {
                text: '❌ Could not resolve this bot\'s session ID — mode not saved. Please report this.'
            }, { quoted: msg });
            return;
        }

        await botData.saveModeToDb(db, realSessionId, action);

        // Always update in-memory cache
        botData.setModeCache(sock, action);

        await sock.sendMessage(chatId, {
            text: action === 'public'
                ? '*PUBLIC MODE*\n\nEveryone can now use bot commands'
                : '*PRIVATE MODE*\n\nOnly owner/sudo can use commands'
        }, { quoted: msg });
    }
};