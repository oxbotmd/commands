/**
 * oxbotai.js — .oxbotai command
 * Branded AI assistant trained (via system prompt in api/oxbotai.php) to
 * introduce itself as "OxBot AI" and help with pairing, the dashboard,
 * and support tickets.
 *
 * Keeps a short in-memory conversation history per user (last 3 turns)
 * so follow-up questions have context. Memory is per-process — resets
 * on bot restart, same tradeoff as afk.js.
 */

const axios = require('axios');

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_AI_API = 'https://lecay.oxbot.name.ng/api/oxbotai.php';

const name     = 'oxbotai';
const aliases  = ['oxai', 'askoxbot'];
const desc     = '🤖 Ask OxBot AI — helps with pairing, dashboard, and support';
const category = 'ai';

const MAX_HISTORY_TURNS = 6; // 3 user + 3 assistant messages
const conversations = new Map(); // senderId -> [{role, content}, ...]

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderNum = cleanNum(senderId);
    const opt = (args[0] || '').toLowerCase();

    if (opt === 'reset' || opt === 'clear') {
        conversations.delete(senderNum);
        return await sock.sendMessage(chatId, { text: '🔄 *Conversation reset.* Ask me anything!' }, { quoted: msg });
    }

    const prompt = args.join(' ').trim();

    if (!prompt) {
        return await sock.sendMessage(chatId, {
            text: `🤖 *OxBot AI*\n\n` +
                  `Ask me about pairing, the dashboard, plans, or support — I'm trained on how OxBot works.\n\n` +
                  `*Usage:* \`.oxbotai <question>\`\n` +
                  `*Example:* \`.oxbotai how do I pair my bot?\`\n\n` +
                  `_\`.oxbotai reset\` clears our conversation history._`
        }, { quoted: msg });
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '🤖', key: msg.key } });
    } catch {}

    let waitMsg = null;
    try {
        waitMsg = await sock.sendMessage(chatId, { text: '🤖 _OxBot AI is thinking..._' }, { quoted: msg });
    } catch {}

    const history = conversations.get(senderNum) || [];

    try {
        const response = await axios.post(OXBOT_AI_API, {
            api_key: OXBOT_API_KEY,
            prompt,
            history,
        }, { timeout: 45000 });

        const data = response.data;

        if (!data?.ok || !data?.reply) {
            throw new Error(data?.error || 'No reply from OxBot AI');
        }

        await deleteMessage(sock, chatId, waitMsg);

        await sock.sendMessage(chatId, {
            text: `🤖 *OxBot AI*\n\n${data.reply}`
        }, { quoted: msg });

        try {
            await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
        } catch {}

        // Update conversation memory
        const updated = [...history, { role: 'user', content: prompt }, { role: 'assistant', content: data.reply }];
        conversations.set(senderNum, updated.slice(-MAX_HISTORY_TURNS));

    } catch (err) {
        console.error('[oxbotai] Error:', err.message);
        await deleteMessage(sock, chatId, waitMsg);

        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
        } catch {}

        let errorMessage = err.message;
        if (err.response?.data?.error) errorMessage = err.response.data.error;
        else if (err.code === 'ECONNABORTED') errorMessage = 'Request timed out.';

        await sock.sendMessage(chatId, {
            text: `❌ *OxBot AI failed*\n\n_${errorMessage}_\n\n_Need help urgently? Open a ticket via Dashboard > Support._`
        }, { quoted: msg });
    }
}

async function deleteMessage(sock, chatId, msg) {
    if (!msg?.key) return;
    try { await sock.sendMessage(chatId, { delete: msg.key }); } catch {}
}

module.exports = { name, aliases, desc, category, execute };