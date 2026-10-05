/**
 * pdf.js — Text to PDF Converter
 * Aliases: .pdf, .topdf
 * Uses centralized Lecay PDF API
 */

const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────

const OXBOT_API_KEY = 'oxb_3b9e894fbc2743382e708f097f475e814646d3db2798b2e6';
const OXBOT_API_URL = 'https://lecay.oxbot.name.ng/api/pdf.php';

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    let textToConvert = '';

    // ── Smart Text Extraction ─────────────────────────────────────────────
    // Check if user replied to a message (Best way to use this command)
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMsg) {
        textToConvert = quotedMsg.conversation || 
                        quotedMsg.extendedTextMessage?.text || 
                        quotedMsg.imageMessage?.caption || 
                        quotedMsg.videoMessage?.caption || '';
    }

    // If not a reply, use the arguments provided directly
    if (!textToConvert) {
        textToConvert = args.join(' ').trim();
    }

    if (!textToConvert) {
        return `📄 *Text to PDF Converter*\n\n*How to use:*\n1. Reply to a long message with: \`.pdf\`\n2. Or type: \`.pdf <your text here>\`\n\n_The bot will arrange it beautifully and send it as a PDF file._`;
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}
    try { await sock.sendMessage(chatId, { react: { text: '📄', key: msg.key } }); } catch {}

    try {
        // ── Call Lecay PDF API ────────────────────────────────────────────
        const { data, headers } = await axios.get(OXBOT_API_URL, {
            params: { 
                api_key: OXBOT_API_KEY, 
                text: textToConvert 
            },
            responseType: 'arraybuffer',
            timeout: 30000,
            validateStatus: () => true, // Handle errors manually
        });

        const buf = Buffer.from(data);
        const contentType = headers['content-type'] || '';

        // ─── ERROR CHECKS ───
        if (contentType.includes('application/json') || buf.length < 1000) {
            let errorMsg = 'Failed to generate PDF.';
            try { 
                const errObj = JSON.parse(buf.toString('utf-8')); 
                errorMsg = errObj.error || errorMsg; 
            } catch {}
            throw new Error(errorMsg);
        }

        console.log(`[PDF] ✓ Generated ${(buf.length / 1024).toFixed(1)} KB PDF`);

        // ── Send PDF to WhatsApp ─────────────────────────────────────────
        // CRITICAL: WhatsApp PDFs MUST be sent as type 'document'
        await sock.sendMessage(chatId, {
            document: buf,
            mimetype: 'application/pdf',
            fileName: 'OxBot_Document.pdf',
            caption: '📄 *Document generated successfully*\n\n_Arranged and formatted by OxBot_'
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;

    } catch (err) {
        console.error('[PDF] Error:', err.message);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        await sock.sendMessage(chatId, {
            text: `❌ *Failed to generate PDF*\n\n_${err.message}_`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'pdf',
    aliases: ['topdf', 'makepdf'],
    desc: 'Convert text messages to beautifully arranged PDF files',
    category: 'general',
    execute
};