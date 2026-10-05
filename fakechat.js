/**
 * commands/fakechat.js
 * Generate a fake WhatsApp-style chat conversation image.
 * Entirely user-supplied content — contact name, messages, and avatar
 * (via reply-image) are all typed/provided by the user. No scraping of
 * real people's photos or handles.
 *
 * Usage (send as ONE message):
 *   .fakechat
 *   Contact: Davido
 *   Me: You dropping the album?
 *   Them: Loading... 🔥
 *   Me: Can't wait!
 *
 * Optional: reply to an image with the command to use it as the contact's
 * avatar. If no reply image is given, a colored circle with the contact's
 * first initial is generated instead.
 *
 * Requires: npm install sharp
 */

const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const name     = 'fakechat';
const aliases  = ['fakewa', 'chatmaker'];
const desc     = '💬 Generate a fake WhatsApp chat conversation image';
const category = 'media';

const WIDTH             = 720;
const BUBBLE_MAX_WIDTH  = 460;
const PADDING           = 24;
const HEADER_HEIGHT     = 90;
const BG_COLOR          = '#0b141a'; // WA dark chat background
const SENT_BUBBLE       = '#005c4b'; // WA dark-theme sent bubble (green)
const RECEIVED_BUBBLE   = '#202c33';
const TEXT_COLOR        = '#e9edef';
const MAX_MESSAGES      = 15;
const MAX_MSG_LENGTH    = 300;

function getRawText(msg) {
    return msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Simple word-wrap for SVG <text> (SVG has no native text wrapping)
function wrapText(text, maxChars) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const w of words) {
        if ((current + ' ' + w).trim().length > maxChars) {
            if (current) lines.push(current.trim());
            current = w;
        } else {
            current += ' ' + w;
        }
    }
    if (current) lines.push(current.trim());
    return lines.length ? lines : [''];
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const raw = getRawText(msg);
    // Strip only the leading ".fakechat"/"!fakewa" etc — keep the rest (with newlines) intact
    const body = raw.replace(/^[.!]\S+\s*/, '').trim();

    if (!body) {
        return await sock.sendMessage(chatId, {
            text: `💬 *Fake Chat Generator*\n\n` +
                  `Send this whole thing as ONE message:\n\n` +
                  '```\n.fakechat\nContact: Davido\nMe: You dropping the album?\nThem: Loading... 🔥\nMe: Can\'t wait!\n```\n\n' +
                  `📌 *Rules:*\n` +
                  `• First line: \`Contact: <name>\`\n` +
                  `• Then alternate \`Me:\` (sent/green) / \`Them:\` (received/grey) lines\n` +
                  `• Reply to an image with the command to use it as the contact's photo\n` +
                  `• Max ${MAX_MESSAGES} messages, ${MAX_MSG_LENGTH} chars each\n\n` +
                  `_⚠️ For parody/entertainment only — don't use this to fake real conversations as fact._`
        }, { quoted: msg });
    }

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

    let contactName = 'Someone';
    const messages = [];

    for (const line of lines) {
        const contactMatch = line.match(/^contact:\s*(.+)$/i);
        if (contactMatch) {
            contactName = contactMatch[1].trim().substring(0, 30);
            continue;
        }
        const meMatch = line.match(/^me:\s*(.+)$/i);
        if (meMatch) {
            messages.push({ sender: 'me', text: meMatch[1].trim().substring(0, MAX_MSG_LENGTH) });
            continue;
        }
        const themMatch = line.match(/^them:\s*(.+)$/i);
        if (themMatch) {
            messages.push({ sender: 'them', text: themMatch[1].trim().substring(0, MAX_MSG_LENGTH) });
            continue;
        }
        // silently ignore lines that don't match the expected prefixes
    }

    if (!messages.length) {
        return await sock.sendMessage(chatId, {
            text: '❌ No messages found!\n\nUse `Me:` and `Them:` prefixes for each line.\nType `.fakechat` alone to see the full example.'
        }, { quoted: msg });
    }

    if (messages.length > MAX_MESSAGES) {
        return await sock.sendMessage(chatId, {
            text: `❌ Too many messages! Max is ${MAX_MESSAGES}, you sent ${messages.length}.`
        }, { quoted: msg });
    }

    // ── Try to grab a reply-to image as the contact avatar ────────────────
    let avatarBuffer = null;
    try {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quoted?.imageMessage) {
            const fakeQuotedMsg = {
                key: {
                    remoteJid: chatId,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    fromMe: false,
                },
                message: quoted,
            };
            avatarBuffer = await downloadMediaMessage(fakeQuotedMsg, 'buffer', {});
        }
    } catch (err) {
        console.error('[fakechat] Avatar download failed:', err.message);
        avatarBuffer = null;
    }

    // ── Build avatar SVG fragment ───────────────────────────────────────────
    const avatarInitial = contactName.trim().charAt(0).toUpperCase() || '?';
    let avatarSvgPart;

    if (avatarBuffer) {
        try {
            const resizedAvatar = await sharp(avatarBuffer).resize(56, 56).png().toBuffer();
            const b64 = resizedAvatar.toString('base64');
            avatarSvgPart = `
                <clipPath id="avatarClip"><circle cx="45" cy="45" r="28"/></clipPath>
                <image href="data:image/png;base64,${b64}" x="17" y="17" width="56" height="56" clip-path="url(#avatarClip)"/>
            `;
        } catch (err) {
            console.error('[fakechat] Avatar resize failed:', err.message);
            avatarBuffer = null;
        }
    }

    if (!avatarBuffer) {
        const colors = ['#00a884', '#8696a0', '#d9534f', '#5bc0de', '#f0ad4e', '#9b59b6'];
        const color = colors[contactName.charCodeAt(0) % colors.length];
        avatarSvgPart = `
            <circle cx="45" cy="45" r="28" fill="${color}"/>
            <text x="45" y="55" font-size="26" fill="white" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold">${escapeXml(avatarInitial)}</text>
        `;
    }

    // ── Layout bubbles ──────────────────────────────────────────────────────
    const CHARS_PER_LINE = 34;
    const LINE_HEIGHT     = 24;
    const BUBBLE_PAD_X    = 16;
    const BUBBLE_PAD_Y    = 12;
    const BUBBLE_GAP      = 14;

    let y = HEADER_HEIGHT + 24;
    const bubbleSvgParts = [];

    for (const m of messages) {
        const wrapped = wrapText(m.text, CHARS_PER_LINE);
        const bubbleHeight = wrapped.length * LINE_HEIGHT + BUBBLE_PAD_Y * 2;
        const longestLine = Math.max(...wrapped.map(l => l.length), 1);
        const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, Math.max(120, longestLine * 11 + BUBBLE_PAD_X * 2));

        const isMe = m.sender === 'me';
        const bx = isMe ? (WIDTH - PADDING - bubbleWidth) : PADDING;
        const fill = isMe ? SENT_BUBBLE : RECEIVED_BUBBLE;

        bubbleSvgParts.push(`<rect x="${bx}" y="${y}" width="${bubbleWidth}" height="${bubbleHeight}" rx="12" ry="12" fill="${fill}"/>`);

        wrapped.forEach((lineText, i) => {
            const ty = y + BUBBLE_PAD_Y + (i + 1) * LINE_HEIGHT - 6;
            const tx = bx + BUBBLE_PAD_X;
            bubbleSvgParts.push(
                `<text x="${tx}" y="${ty}" font-size="18" fill="${TEXT_COLOR}" font-family="Arial, sans-serif">${escapeXml(lineText)}</text>`
            );
        });

        y += bubbleHeight + BUBBLE_GAP;
    }

    const totalHeight = y + PADDING;

    const svg = `
        <svg width="${WIDTH}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${WIDTH}" height="${totalHeight}" fill="${BG_COLOR}"/>
            <rect x="0" y="0" width="${WIDTH}" height="${HEADER_HEIGHT}" fill="#202c33"/>
            ${avatarSvgPart}
            <text x="92" y="52" font-size="22" fill="white" font-family="Arial, sans-serif" font-weight="bold">${escapeXml(contactName)}</text>
            <text x="92" y="74" font-size="14" fill="#8696a0" font-family="Arial, sans-serif">online</text>
            ${bubbleSvgParts.join('\n')}
        </svg>
    `;

    try {
        const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

        await sock.sendMessage(chatId, {
            image: pngBuffer,
            caption: `💬 Fake chat with *${contactName}*\n\n_⚠️ Parody/entertainment only — not a real conversation._`
        }, { quoted: msg });

    } catch (err) {
        console.error('[fakechat] Render error:', err.message);
        await sock.sendMessage(chatId, { text: `❌ Failed to generate chat image: ${err.message}` }, { quoted: msg });
    }
}

module.exports = { name, aliases, desc, category, execute };