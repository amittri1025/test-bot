// index.js  — minimal version focused on window.__APP parsing
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const cheerio = require('cheerio');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

function escapeMd(text) {
  return (text || '').replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}

async function extractSellerInfo(adInput) {
  let adId;
  if (/^\d{9,11}$/.test(adInput)) {
    adId = adInput;
  } else {
    const m = adInput.match(/iid[-_](\d+)/i) || adInput.match(/\/(\d{9,})\b/);
    if (!m) return { error: 'Cannot parse ad ID' };
    adId = m[1];
  }

  const url = `https://www.olx.in/item/iid-${adId}`;

  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      responseType : 'text'
    });

    const $ = cheerio.load(html);

    let jsonText = null;

    $('script').each((i, el) => {
      const txt = $(el).html() || '';
      if (txt.includes('window.__APP = {')) {
        const start = txt.indexOf('window.__APP = ');
        if (start === -1) return;

        let part = txt.slice(start + 'window.__APP = '.length).trim();

        // remove trailing ; or extra code after the object
        const lastBrace = part.lastIndexOf('}');
        if (lastBrace > 200) {
          part = part.substring(0, lastBrace + 1);
        }

        jsonText = part;
        return false; // stop after first match
      }
    });

    if (!jsonText) {
      return { error: 'window.__APP block not found' };
    }

    let appData;
    try {
      appData = JSON.parse(jsonText);
    } catch (e) {
      return { error: 'JSON parse failed: ' + e.message.slice(0, 120) };
    }

    // Navigate to users.elements → look for any user with phone
    const users = appData?.props?.pageProps?.users?.elements ||
                 appData?.props?.users?.elements ||
                 appData?.users?.elements || {};

    let phone = null;
    let name = null;
    let location = null;

    for (const userId in users) {
      const u = users[userId];
      if (u?.phone && u.phone.startsWith('+91')) {
        phone = u.phone;
        name = u.name || '—';
        location = u.locations?.[0] ? 
          `${u.locations[0].lat?.toFixed(4)}, ${u.locations[0].lon?.toFixed(4)}` : 
          '—';
        break;
      }
    }

    if (!phone) {
      return { error: 'No user with phone number found in __APP data' };
    }

    return {
      phone,
      name,
      location
    };

  } catch (err) {
    return { error: err.message.slice(0, 140) };
  }
}

// ─── Bot ─────────────────────────────────────────────

bot.start(ctx => ctx.reply('Send OLX ad URL or numeric ad ID'));

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.length < 8 || text.startsWith('/')) return;

  const msg = await ctx.reply('⏳ Checking...');

  const result = await extractSellerInfo(text);

  let reply;
  if (result.error) {
    reply = `❌ ${result.error}`;
  } else {
    reply = [
      `Phone: \`${result.phone}\``,
      `Name: ${escapeMd(result.name)}`,
      `Location coords: ${escapeMd(result.location)}`
    ].join('\n');
  }

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      reply,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {
    ctx.reply('Formatting failed – raw result:\n' + JSON.stringify(result, null, 2));
  }
});

bot.launch()
  .then(() => console.log('Bot running'))
  .catch(err => console.error('Launch failed:', err));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));