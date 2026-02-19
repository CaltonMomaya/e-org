const {
  getAccessToken,
  getRequiredEnv,
  getOptionalEnv,
  json,
  normalizeMsisdn,
  supabaseUpsertMpesaTransaction
} = require('./utils');

// Helper function for CORS headers
const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
};

module.exports = async (req, res) => {
  // Set CORS headers for all responses
  setCorsHeaders(res);

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Method not allowed. Use POST.' 
    }));
    return;
  }

  try {
    console.log('STK Push request received');
    
    const body = await json(req);
    console.log('Request body:', JSON.stringify(body));
    
    const phone = normalizeMsisdn(body.phone);
    const amount = Number(body.amount);
    const reference = String(body.reference || '').trim();
    const items = body.items || [];

    if (!phone) {
      throw new Error('Phone is required. Please enter a valid Safaricom number (07 or 01)');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Amount must be a positive number');
    }
    if (!reference) {
      throw new Error('Reference is required');
    }

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

    const callbackUrl = process.env.MPESA_CALLBACK_URL || 
      `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/mpesa/callback`;

    // Validate callback URL
    if (!callbackUrl || !callbackUrl.startsWith('http')) {
      throw new Error('Invalid callback URL configuration');
    }

    // Store cart items in metadata
    const metadata = {
      items: items,
      reference: reference,
      timestamp: new Date().toISOString()
    };

    const pendingTransaction = {
      order_id: null,
      checkout_request_id: null,
      merchant_request_id: null,
      amount: Math.round(amount),
      phone_number: phone,
      result_code: null,
      result_desc: null,
      status: 'initiating',
      metadata: metadata
    };
    
    await supabaseUpsertMpesaTransaction(pendingTransaction);

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: reference.substring(0, 12), // M-Pesa limit
      TransactionDesc: `Order ${reference.substring(0, 12)}`
    };

    console.log('M-Pesa payload:', JSON.stringify(payload));

    const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    const responseText = await response.text();
    console.log('M-Pesa response status:', response.status);
    console.log('M-Pesa response body:', responseText);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse M-Pesa response:', responseText);
      throw new Error('Invalid response from M-Pesa');
    }

    if (!response.ok) {
      await supabaseUpsertMpesaTransaction({
        ...pendingTransaction,
        status: 'failed',
        result_code: String(data.errorCode || data.ResponseCode || 'http_error'),
        result_desc: data.errorMessage || data.ResponseDescription || 'STK push HTTP failed'
      });

      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        success: false, 
        message: 'STK push failed', 
        details: data 
      }));
      return;
    }

    const ok = data.ResponseCode === '0' || data.ResponseCode === 0;

    await supabaseUpsertMpesaTransaction({
      order_id: null,
      checkout_request_id: data.CheckoutRequestID || null,
      merchant_request_id: data.MerchantRequestID || null,
      amount: Math.round(amount),
      phone_number: phone,
      result_code: ok ? null : String(data.ResponseCode ?? ''),
      result_desc: ok ? null : (data.ResponseDescription || null),
      status: ok ? 'pending' : 'failed',
      metadata: metadata
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: ok,
      message: data.ResponseDescription || (ok ? 'STK push initiated' : 'STK push rejected'),
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID
    }));
    
  } catch (error) {
    console.error('STK Push error:', error);
    
    // Handle timeout specifically
    if (error.name === 'TimeoutError') {
      res.statusCode = 408;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Request timeout. M-Pesa servers are taking too long to respond.' 
      }));
      return;
    }
    
    // Handle network errors
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Network error. Unable to connect to M-Pesa servers.' 
      }));
      return;
    }
    
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 
      success: false, 
      message: error.message || 'Bad request'
    }));
  }
};