/**
 * commands/siteinfo.js — Website Metadata / Link Preview Fetcher
 * Aliases: .site, .urlinfo, .preview
 *
 * Fetches a URL and extracts standard public page metadata: title,
 * description, OG/Twitter card image, favicon, and basic server info
 * (status code, content type, final URL after redirects). This is
 * exactly what any browser or link-preview bot reads from a public
 * page's <head> — nothing beyond what's already served to anyone
 * who visits the link.
 */

const axios = require('axios');

const URL_REGEX = /^https?:\/\/.+/i;

function isValidUrl(str) {
    if (!URL_REGEX.test(str)) return false;
    try { new URL(str); return true; } catch { return false; }
}

function extractMeta(html, baseUrl) {
    const get = (re) => {
        const m = html.match(re);
        return m ? m[1].trim() : null;
    };

    const title =
        get(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
        get(/<title[^>]*>([^<]+)<\/title>/i);

    const description =
        get(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
        get(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

    let image =
        get(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
        get(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);

    let favicon =
        get(/<link\s+rel=["'](?:shortcut )?icon["']\s+href=["']([^"']+)["']/i) ||
        get(/<link\s+href=["']([^"']+)["']\s+rel=["'](?:shortcut )?icon["']/i);

    const siteName = get(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i);

    // Resolve relative image/favicon URLs against the page's own origin.
    const resolve = (u) => {
        if (!u) return null;
        try { return new URL(u, baseUrl).href; } catch { return u; }
    };

    return {
        title: title ? decodeHtmlEntities(title) : null,
        description: description ? decodeHtmlEntities(description) : null,
        image: resolve(image),
        favicon: resolve(favicon),
        siteName: siteName ? decodeHtmlEntities(siteName) : null,
    };
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

async function fetchSiteInfo(url) {
    const res = await axios.get(url, {
        timeout: 20000,
        maxContentLength: 5 * 1024 * 1024, // don't pull huge pages fully into memory
        validateStatus: () => true, // we want to report the real status, not throw on 4xx/5xx
        maxRedirects: 5,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
        },
    });

    const finalUrl = res.request?.res?.responseUrl || res.config?.url || url;
    const contentType = res.headers['content-type'] || 'unknown';
    const isHtml = contentType.includes('text/html');

    const meta = isHtml ? extractMeta(String(res.data), finalUrl) : {};

    return {
        status: res.status,
        finalUrl,
        contentType,
        server: res.headers['server'] || null,
        ...meta,
    };
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!args || args.length === 0) {
        return `*🌐 SITE INFO*\n\n*.site <url>* — Fetch title, description, preview image, and server info for any URL\n\n*Aliases:* .urlinfo  .preview`;
    }

    let url = args[0].trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!isValidUrl(url)) return `❌ *Invalid URL*`;

    try { await sock.sendMessage(chatId, { react: { text: '🔍', key: msg.key } }); } catch {}

    let info;
    try {
        info = await fetchSiteInfo(url);
    } catch (err) {
        console.log(`[siteinfo] Error — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Could not reach that site*\n\n_${err.message}_`;
    }

    const lines = [`*🌐 SITE INFO*`];
    if (info.title) lines.push(`\n*Title:* ${info.title}`);
    if (info.siteName) lines.push(`*Site:* ${info.siteName}`);
    if (info.description) lines.push(`*Description:* ${info.description}`);
    lines.push(`*Status:* ${info.status}`);
    lines.push(`*Content-Type:* ${info.contentType}`);
    if (info.server) lines.push(`*Server:* ${info.server}`);
    if (info.finalUrl !== url) lines.push(`*Redirected to:* ${info.finalUrl}`);

    try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}

    // Send with the preview image if one was found, otherwise plain text.
    if (info.image) {
        try {
            await sock.sendMessage(chatId, {
                image: { url: info.image },
                caption: lines.join('\n'),
            }, { quoted: msg });
            return null;
        } catch {
            // image fetch/send failed — fall through to text-only
        }
    }

    return lines.join('\n');
}

module.exports = {
    name: 'siteinfo',
    aliases: ['site', 'urlinfo', 'preview'],
    desc: 'Fetch title, description, preview image, and server info for a URL',
    category: 'utility',
    execute,
};
