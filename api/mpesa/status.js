const { json, supabaseGetMpesaTransactionByCheckoutRequestId } = require('./utils');

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
    const checkoutRequestId = String(body.checkoutRequestId || '').trim();
    if (!checkoutRequestId) throw new Error('checkoutRequestId is required');

    const tx = await supabaseGetMpesaTransactionByCheckoutRequestId(checkoutRequestId);

    // If no record yet, report pending so frontend continues polling.
    if (!tx) {
      res.statusCode = 200;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, status: 'pending', source: 'supabase', exists: false }));
      return;
    }

    // Map status to user-friendly messages
    let status = tx.status || 'pending';
    let resultDesc = tx.result_desc || '';
    
    // Handle cancellation specifically
    if (tx.result_code === '1032' || (resultDesc && resultDesc.toLowerCase().includes('cancel'))) {
      status = 'cancelled';
    }

    res.statusCode = 200;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        status: status,
        resultCode: tx.result_code,
        resultDesc: resultDesc,
        source: 'supabase',
        exists: true
      })
    );
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, message: e.message || 'Bad request' }));
  }
};