const getEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
};

const getFirstEnv = (keys) => {
  for (const k of keys) {
    const v = process.env[k];
    if (v) return v;
  }
  return undefined;
};

const getRequiredEnv = (keys, label) => {
  const v = getFirstEnv(keys);
  if (!v) throw new Error(`Missing env var ${label || keys[0]}`);
  return v;
};

const getOptionalEnv = (k) => {
  const v = process.env[k];
  return v || '';
};

const json = async (req) => {
  // Some serverless runtimes (e.g. Vercel) may populate req.body for us.
  if (req && req.body != null) {
    if (typeof req.body === 'string') {
      const s = req.body.trim();
      if (!s) return {};
      return JSON.parse(s);
    }
    if (typeof req.body === 'object') return req.body;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
};

const getAccessToken = async () => {
  const env = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
  const isProd = env === 'production' || env === 'prod' || env === 'live';
  const baseUrl = isProd ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

  const consumerKey = getRequiredEnv(
    ['MPESA_CONSUMER_KEY', 'MPESA_LIVE_CONSUMER_KEY', 'MPESA_PROD_CONSUMER_KEY'],
    'MPESA_CONSUMER_KEY'
  );
  const consumerSecret = getRequiredEnv(
    ['MPESA_CONSUMER_SECRET', 'MPESA_LIVE_CONSUMER_SECRET', 'MPESA_PROD_CONSUMER_SECRET'],
    'MPESA_CONSUMER_SECRET'
  );

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const r = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15000) // 15 second timeout for OAuth
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OAuth failed: ${r.status} ${t}`);
  }

  const data = await r.json();
  if (!data.access_token) throw new Error('OAuth response missing access_token');
  return { accessToken: data.access_token, baseUrl };
};

const supabaseUpsertMpesaTransaction = async (transaction) => {
  const url = getOptionalEnv('SUPABASE_URL');
  const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
  if (!url || !key) return;

  try {
    const r = await fetch(`${url}/rest/v1/mpesa_transactions`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify([transaction])
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn(`Supabase mpesa_transactions insert failed: ${r.status} ${t}`);
    }
  } catch (error) {
    console.error('Supabase upsert error:', error);
  }
};

const supabaseGetMpesaTransactionByCheckoutRequestId = async (checkoutRequestId) => {
  const url = getOptionalEnv('SUPABASE_URL');
  const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
  if (!url || !key) return null;
  if (!checkoutRequestId) return null;

  try {
    const r = await fetch(
      `${url}/rest/v1/mpesa_transactions?checkout_request_id=eq.${encodeURIComponent(
        checkoutRequestId
      )}&select=*&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!r.ok) return null;
    const rows = await r.json().catch(() => null);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Supabase get error:', error);
    return null;
  }
};

const supabaseUpdateMpesaTransactionByCheckoutRequestId = async (checkoutRequestId, patch) => {
  const url = getOptionalEnv('SUPABASE_URL');
  const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
  if (!url || !key) return;
  if (!checkoutRequestId) return;

  try {
    const r = await fetch(
      `${url}/rest/v1/mpesa_transactions?checkout_request_id=eq.${encodeURIComponent(checkoutRequestId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
      }
    );

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn(`Supabase update failed: ${r.status} ${t}`);
    }
  } catch (error) {
    console.error('Supabase update error:', error);
  }
};

const normalizeMsisdn = (input) => {
  const s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  
  const digits = s.replace(/\D/g, '');
  
  if (digits.startsWith('254')) {
    if (digits.length === 12 && digits.startsWith('2540')) {
      return '254' + digits.slice(4);
    }
    if (digits.length === 12 && (digits.startsWith('2547') || digits.startsWith('2541'))) {
      return digits;
    }
  } else if (digits.startsWith('0')) {
    if (digits.length === 10) {
      const normalized = '254' + digits.slice(1);
      if (normalized.startsWith('2547') || normalized.startsWith('2541')) {
        return normalized;
      }
    }
  } else if (digits.length === 9 && digits.startsWith('7')) {
    return '254' + digits;
  } else if (digits.length === 10 && digits.startsWith('11')) {
    return '254' + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith('11')) {
    return '2541' + digits.slice(1);
  }
  
  if (/^254[71]\d{8}$/.test(digits)) {
    return digits;
  }
  
  return null;
};

const pickCallbackValue = (items, name) => {
  if (!Array.isArray(items)) return null;
  const found = items.find((i) => i && String(i.Name || '').toLowerCase() === String(name).toLowerCase());
  if (!found) return null;
  if (Object.prototype.hasOwnProperty.call(found, 'Value')) return found.Value;
  return null;
};

module.exports = {
  getEnv,
  getFirstEnv,
  getRequiredEnv,
  getOptionalEnv,
  json,
  getAccessToken,
  supabaseGetMpesaTransactionByCheckoutRequestId,
  supabaseUpsertMpesaTransaction,
  supabaseUpdateMpesaTransactionByCheckoutRequestId,
  normalizeMsisdn,
  pickCallbackValue
};