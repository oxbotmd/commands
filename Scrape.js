/**
 * OxBot — Scrape Command (Owner Only)
 * Fetches a site's raw HTML and sends it as a downloadable file
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const dns   = require('dns').promises;
const net   = require('net');

const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB — HTML pages are rarely this big; catches runaway responses
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// ── Strip device/LID suffix so JIDs always compare cleanly ──
function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

// ── Fetch owner phone from users table for this session ──
async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[scrape] DB error fetching owner:', err.message);
        return null;
    }
}

// ── Check if sender is the owner for this session ──
async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid)          return true;
    if (senderClean === ownerNumber)    return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata     = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];

            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });

            if (match) return true;
        } catch (e) {
            console.error('[scrape] Group LID check error:', e.message);
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ SSRF GUARD ★
// ═══════════════════════════════════════════════════════════════════════════════

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 169 && parts[1] === 254) return true; // link-local / cloud metadata
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 0) return true;
        return false;
    }
    // IPv6 — block loopback and unique local addresses
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('fe80')) return true; // link-local
    return false;
}

async function assertSafeUrl(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        throw new Error('Not a valid URL.');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http:// and https:// URLs are allowed.');
    }

    const hostname = parsed.hostname;
    if (['localhost'].includes(hostname.toLowerCase())) {
        throw new Error('Local/internal addresses are not allowed.');
    }

    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true });
    } catch {
        throw new Error('Could not resolve that host.');
    }

    for (const { address } of addresses) {
        if (isPrivateIp(address)) {
            throw new Error('That address resolves to a private/internal IP — not allowed.');
        }
    }

    return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ FETCH HELPER ★
// ═══════════════════════════════════════════════════════════════════════════════

function fetchHtml(urlString, redirectsLeft = MAX_REDIRECTS) {
    return new Promise(async (resolve, reject) => {
        let parsed;
        try {
            parsed = await assertSafeUrl(urlString);
        } catch (err) {
            return reject(err);
        }

        const client = parsed.protocol === 'https:' ? https : http;

        const req = client.get(parsed, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OxBot/1.0)' },
            timeout: FETCH_TIMEOUT_MS,
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) {
                    return reject(new Error('Too many redirects.'));
                }
                const nextUrl = new URL(res.headers.location, parsed).toString();
                return resolve(fetchHtml(nextUrl, redirectsLeft - 1));
            }

            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Site returned status ${res.statusCode}`));
            }

            let data = '';
            let size = 0;
            let rejected = false;

            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_SIZE_BYTES) {
                    rejected = true;
                    res.destroy();
                    return reject(new Error(`Response exceeds ${(MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB limit.`));
                }
                data += chunk;
            });

            res.on('end', () => {
                if (!rejected) resolve({ html: data, finalUrl: parsed.toString() });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out.'));
        });

        req.on('error', (err) => reject(err));
    });
}

function safeFileNameFromUrl(urlString) {
    try {
        const u = new URL(urlString);
        const host = u.hostname.replace(/[^a-z0-9.-]/gi, '_');
        return `${host}-${Date.now()}.html`;
    } catch {
        return `scrape-${Date.now()}.html`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Database error. Please restart the bot.'
        }, { quoted: msg });
        return null;
    }

    // ── Owner check ──
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(
        botData.db, botData.sessionId, senderId, sock, chatId
    );

    if (!msg.key.fromMe && !senderIsOwner) {
        await sock.sendMessage(chatId, {
            text: '❌ This command is only available for the owner!'
        }, { quoted: msg });
        return null;
    }

    const input = (args[0] || '').trim();
    if (!input) {
        return await sock.sendMessage(chatId, {
            text: '🌐 Usage: `.scrape https://example.com`'
        }, { quoted: msg });
    }

    const target = input.match(/^https?:\/\//i) ? input : `https://${input}`;

    await sock.sendMessage(chatId, { text: `🔍 Fetching *${target}*...` }, { quoted: msg });

    let tmpFile;
    try {
        const { html, finalUrl } = await fetchHtml(target);

        tmpFile = path.join(os.tmpdir(), safeFileNameFromUrl(finalUrl));
        fs.writeFileSync(tmpFile, html, 'utf8');

        const stats = fs.statSync(tmpFile);
        await sock.sendMessage(chatId, {
            document: fs.readFileSync(tmpFile),
            fileName: path.basename(tmpFile),
            mimetype: 'text/html',
            caption: `📄 Scraped: ${finalUrl}\nSize: ${(stats.size / 1024).toFixed(1)}KB`,
        });
    } catch (err) {
        await sock.sendMessage(chatId, { text: `❌ Scrape failed: ${err.message}` }, { quoted: msg });
    } finally {
        if (tmpFile) fs.unlink(tmpFile, () => {});
    }

    return null;
}

module.exports = {
    name: 'scrape',
    execute: execute,
    desc: 'Fetch a site\'s HTML and send it as a file (Owner)',
    category: 'owner',
    aliases: ['getsite', 'sitecode']
};