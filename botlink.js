/**
 * commands/botlink.js
 * Get bot pairing link
 */

const name     = 'botlink';
const aliases  = ['pair', 'pairing', 'connect'];
const desc     = 'Get bot pairing/connection link';
const category = 'general';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const pairUrl = 'https://oxbot.name.ng';

    let text = `╭━━━【 *BOT PAIRING LINK* 】━━━╮\n`;
    text += `│ 🤖 *Want to pair your own bot?*\n`;
    text += `│\n`;
    text += `│ 📌 *Steps:*\n`;
    text += `│ 1️⃣ Open the link below\n`;
    text += `│ 2️⃣ Scan the QR code with WhatsApp\n`;
    text += `│ 3️⃣ Your bot will be connected!\n`;
    text += `│\n`;
    text += `│ 🔗 *Link:* ${pairUrl}\n`;
    text += `╰━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
    text += `⚠️ _Only scan on a secondary number,\nnot your main WhatsApp account!_`;

    await sock.sendMessage(chatId, { text }, { quoted: msg });

    return null;
}

module.exports = { name, aliases, desc, category, execute };