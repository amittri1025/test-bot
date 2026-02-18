// Replace the entire scrapePhone function with this one

async function scrapePhone(input, attempt = 1) {
  let adId;
  if (/^\d{9,11}$/.test(input)) {
    adId = input;
  } else {
    const m = input.match(/iid[-_](\d+)/i) || input.match(/\/(\d{9,})\b/);
    if (!m) return { error: 'Cannot extract ad ID from input' };
    adId = m[1];
  }

  const url = `${BASE_URL}/item/iid-${adId}`;

  try {
    const response = await limit(() =>
      axios.get(url, {
        timeout: 10000,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        }
      })
    );

    const html = response.data;

    // ─── Find window.__APP = { ... ────────────────────────────────
    const appStartMarker = 'window.__APP = {';
    const startIndex = html.indexOf(appStartMarker);

    if (startIndex === -1) {
      return { status: 'NO_APP_DATA', error: 'window.__APP not found' };
    }

    // Rough cut — take from = to the matching closing brace
    let jsonStr = html.slice(startIndex + 'window.__APP = '.length);

    // Find the balancing }
    let braceCount = 0;
    let endIndex = 0;
    for (let i = 0; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') braceCount++;
      if (jsonStr[i] === '}') braceCount--;
      if (braceCount === 0) {
        endIndex = i + 1;
        break;
      }
    }

    if (endIndex === 0) {
      return { status: 'PARSE_FAIL', error: 'Could not balance braces' };
    }

    jsonStr = jsonStr.substring(0, endIndex);

    let appData;
    try {
      appData = JSON.parse(jsonStr);
    } catch (parseErr) {
      return {
        status: 'JSON_ERROR',
        error: 'JSON parse failed: ' + parseErr.message.slice(0, 100)
      };
    }

    // ─── Look for user with phone ────────────────────────────────
    const users = appData?.props?.users?.elements ||
                  appData?.users?.elements || {};

    let foundPhone = null;
    let foundName = null;

    for (const uid in users) {
      const user = users[uid];
      if (user?.phone && user.phone.startsWith('+91') && user.phone.length === 13) {
        foundPhone = user.phone;
        foundName = user.name || null;
        break;
      }
    }

    if (!foundPhone) {
      return {
        id: adId,
        phone: null,
        status: 'NO_PHONE',
        count: 0
      };
    }

    return {
      id: adId,
      phone: foundPhone,
      status: 'SUCCESS',
      count: 1,
      name: foundName
    };

  } catch (err) {
    if (attempt === 1 && (err.code === 'ECONNABORTED' || err?.response?.status >= 500)) {
      console.log(`Retry ${adId} (attempt 2)`);
      await delay(2500 + Math.random() * 2000);
      return scrapePhone(input, 2);
    }

    return {
      id: adId,
      phone: null,
      status: 'ERROR',
      error: err.message.slice(0, 140)
    };
  }
}