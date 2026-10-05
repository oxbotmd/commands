/**
 * OxBot — Telegram Channel Command
 * Sends the official Telegram channel link
 *
 * Usage: .telegram
 */

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    await sock.sendMessage(chatId, {
        text: `📡 *OxBot on Telegram*\n\n` +
              `Join our Telegram channel for updates, announcements, new features, and more!\n\n` +
              `🔗 *Link:* https://t.me/ox_bot18\n\n` +
              `_Tap the link above to join now!_`
    }, { quoted: msg });
}

module.exports = {
    name: 'telegram',
    execute: execute,
    desc: 'Get the official Telegram channel link',
    category: 'info',
    aliases: ['tg', 'channel']
};