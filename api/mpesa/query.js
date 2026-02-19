const {
  getAccessToken,
  getRequiredEnv,
  json,
  supabaseGetMpesaTransactionByCheckoutRequestId,
  supabaseUpdateMpesaTransactionByCheckoutRequestId
} = require('./utils');

module.exports = async (req, res) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: 'Method not allowed. Use POST.' }));
    return;
  }

  try {
    const body = await json(req);

    // Be tolerant: in some serverless setups the body may be missing/empty.
    // Accept checkoutRequestId from body, req.query, or URL querystring.
    const fromBody = body && body.checkoutRequestId != null ? body.checkoutRequestId : null;
    const fromReqQuery = req && req.query && req.query.checkoutRequestId != null ? req.query.checkoutRequestId : null;
    let fromUrl = null;
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      fromUrl = u.searchParams.get('checkoutRequestId');
    } catch (e) {
      // ignore
    }

    const checkoutRequestId = String(fromBody || fromReqQuery || fromUrl || '').trim();

    if (!checkoutRequestId) {
      return res.status(400).json({ 
        success: false, 
        message: 'checkoutRequestId is required' 
      });
    }

    // Source of truth: if callback already updated Supabase to a final status,
    // return that immediately so the frontend doesn't get stuck on "processing".
    const existing = await supabaseGetMpesaTransactionByCheckoutRequestId(checkoutRequestId);
    if (existing && existing.status && ['success', 'failed', 'cancelled'].includes(String(existing.status))) {
      return res.status(200).json({
        success: true,
        resultCode: existing.result_code,
        resultDesc: existing.result_desc,
        status: existing.status,
        source: 'supabase'
      });
    }

    // If no transaction found yet, return pending
    if (!existing) {
      return res.status(200).json({
        success: true,
        status: 'pending',
        source: 'supabase',
        exists: false
      });
    }

    // Query M-Pesa for status
    try {
      const { accessToken, baseUrl } = await getAccessToken();

      const shortcode = getRequiredEnv(
        ['MPESA_SHORTCODE', 'MPESA_LIVE_SHORT_CODE', 'MPESA_LIVE_SHORTCODE', 'MPESA_PROD_SHORTCODE'],
        'MPESA_SHORTCODE'
      );
      const passkey = getRequiredEnv(
        ['MPESA_PASSKEY', 'MPESA_LIVE_CONSUMER_PASSKEY', 'MPESA_LIVE_PASSKEY', 'MPESA_PROD_PASSKEY'],
        'MPESA_PASSKEY'
      );
      const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

      const payload = {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      };

      const r = await fetch(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await r.json().catch(async () => ({ raw: await r.text() }));

      if (!r.ok) {
        console.warn('M-Pesa query failed:', data);
        // Don't throw, just return what we have from Supabase
        return res.status(200).json({
          success: true,
          status: existing.status || 'pending',
          resultCode: existing.result_code,
          resultDesc: existing.result_desc,
          source: 'supabase_fallback'
        });
      }

      const resultCode = data.ResultCode;
      const resultDesc = data.ResultDesc;

      // Determine status based on result code
      let status = 'pending';
      if (resultCode === '0' || resultCode === 0) {
        status = 'success';
      } else if (resultCode === '1032' || resultCode === 1032) {
        status = 'cancelled';
      } else if (resultCode && resultCode !== '1037') {
        // 1037 is timeout - still pending
        status = 'failed';
      }

      // Update transaction in database
      await supabaseUpdateMpesaTransactionByCheckoutRequestId(checkoutRequestId, {
        result_code: resultCode != null ? String(resultCode) : null,
        result_desc: resultDesc || null,
        status
      });

      return res.status(200).json({
        success: true,
        resultCode,
        resultDesc,
        status,
        source: 'mpesa_query',
        raw: data
      });

    } catch (mpesaError) {
      console.error('M-Pesa query error:', mpesaError);
      // Return what we have from Supabase
      return res.status(200).json({
        success: true,
        status: existing.status || 'pending',
        resultCode: existing.result_code,
        resultDesc: existing.result_desc,
        source: 'supabase_error_fallback'
      });
    }

  } catch (e) {
    console.error('Status query error:', e);
    res.statusCode = 400;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 
      success: false, 
      message: e.message || 'Bad request',
      error: e.toString()
    }));
  }
};