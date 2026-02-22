require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const pLimit = require('p-limit');
const express = require('express');

const app = express();
app.use(express.json());

const CONCURRENCY = 4;
const limit = pLimit(CONCURRENCY);

const BASE_URL = 'https://www.olx.in';
const PHONE_REGEX = /"phone"\s*:\s*"(\+91\d{10})"/g;

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const phoneCache = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapePhone(input, attempt = 1) {
  let adId;

  if (/^\d{9,11}$/.test(input)) {
    adId = input;
  } else {
    const m = input.match(/iid[-_](\d+)/i) || input.match(/\/(\d{9,})\b/);
    if (!m) return { error: 'Cannot extract ad ID from input' };
    adId = m[1];
  }

  const cacheKey = adId;
  const cached = phoneCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 20 * 60_000) {
    return { id: adId, phone: cached.phone, cached: true };
  }

  const url = `${BASE_URL}/item/iid-${adId}`;

  try {
    const response = await limit(() =>
      axios.get(url, {
        timeout: 8000,
        responseType: 'text',
        // Uncomment only if you start getting blocked
        // headers: {
        //   'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        // },
      })
    );

    const html = response.data;

    PHONE_REGEX.lastIndex = 0;
    const phones = [];
    let m;
    while ((m = PHONE_REGEX.exec(html)) !== null) {
      phones.push(m[1]);
    }

    const phone = phones[0] ?? null;

    if (phone) {
      phoneCache.set(cacheKey, { phone, ts: Date.now() });
    }

    return {
      id: adId,
      phone,
      status: phone ? 'SUCCESS' : 'NO_PHONE',
      count: phones.length,
      cached: false,
    };
  } catch (err) {
    if (attempt === 1 && (err.code === 'ECONNABORTED' || err?.response?.status >= 500)) {
      console.log(`Retry ${adId} (attempt 2)`);
      await delay(2500 + Math.random() * 2000);
      return scrapePhone(input, 2);
    }

    console.error(`Failed to scrape ${adId}:`, err.message);
    return {
      id: adId,
      phone: null,
      status: 'ERROR',
      error: err.message.slice(0, 140),
    };
  }
}

// ─── Bot handlers ─────────────────────────────────────

bot.start((ctx) => {
  ctx.replyWithMarkdownV2(
    'Paste an *OLX ad link* or just the numeric *ad ID*\\.\n\n' +
      'Examples:\n' +
      '`https://www\\.olx\\.in/item/iid\\-1987654321`\n' +
      '`1987654321`'
  );
});

bot.on('text', async (ctx) => {
  const txt = ctx.message.text.trim();
  if (txt.length < 8 || txt.startsWith('/')) return;

  if (!txt.includes('olx.in') && !/^\d{9,11}$/.test(txt)) {
    return ctx.reply('Please send a valid OLX URL or ad ID (9–11 digits).');
  }

  const statusMsg = await ctx.reply('⏳ Extracting phone...');

  try {
    const r = await scrapePhone(txt);

    if (r.error) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `❌ ${r.error}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (r.status === 'ERROR') {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `⚠️ ${r.error || 'Request failed'}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (!r.phone) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `No phone found\\.\n\nAd ID: \`${r.id}\``,
        { parse_mode: 'Markdown' }
      );
    }

    const cacheNote = r.cached ? ' \\(cached\\)' : '';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `*Phone:* \`${r.phone}\`${cacheNote}\nAd ID: \`${r.id}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Bot runtime error:', err);
    ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      'Internal error — try again later\\.'
    );
  }
});

bot.catch((err, ctx) => {
  console.error('Telegraf error:', err);
});

// ─── Launch ───────────────────────────────────────────

//async function launch() {
  // console.log('Starting bot...');
  // await bot.launch();
  // console.log(`Bot @${bot.botInfo?.username ?? 'unknown'} is running`);

  // process.once('SIGINT', () => bot.stop('SIGINT'));
  // process.once('SIGTERM', () => bot.stop('SIGTERM'));
  
//}

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = `/bot${process.env.BOT_TOKEN}`;

app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

async function launch() {
  console.log('Starting server...');

  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}${WEBHOOK_PATH}`;

    await bot.telegram.setWebhook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
  });
}

launch();