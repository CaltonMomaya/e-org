const {
  json,
  getOptionalEnv,
  supabaseUpsertMpesaTransaction,
  supabaseUpdateMpesaTransactionByCheckoutRequestId,
  pickCallbackValue
} = require('./utils');

// Deduct inventory function
const deductInventory = async (items, checkoutRequestId) => {
  const url = getOptionalEnv('SUPABASE_URL');
  const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
  
  if (!url || !key) {
    console.warn('Cannot deduct inventory: missing database configuration');
    return false;
  }

  try {
    console.log('Deducting inventory for checkout:', checkoutRequestId);
    
    // If we have items from the order, use them
    if (items && items.length > 0) {
      for (const item of items) {
        // Get current stock
        const stockResponse = await fetch(
          `${url}/rest/v1/products?id=eq.${item.id}&select=stock`,
          {
            method: 'GET',
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        if (stockResponse.ok) {
          const stockData = await stockResponse.json();
          if (stockData && stockData.length > 0) {
            const currentStock = stockData[0].stock;
            const newStock = currentStock - item.quantity;
            
            if (newStock >= 0) {
              // Update stock
              await fetch(
                `${url}/rest/v1/products?id=eq.${item.id}`,
                {
                  method: 'PATCH',
                  headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ stock: newStock })
                }
              );
              console.log(`Updated stock for product ${item.id}: ${currentStock} -> ${newStock}`);
            }
          }
        }
      }
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error deducting inventory:', error);
    return false;
  }
};

module.exports = async (req, res) => {
  try {
    const body = await json(req);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));

    const log = {
      at: new Date().toISOString(),
      headers: req.headers,
      body
    };

    console.log(JSON.stringify({ mpesa_callback: log }));

    const stk = body && body.Body && body.Body.stkCallback ? body.Body.stkCallback : null;
    if (stk) {
      const checkoutRequestId = stk.CheckoutRequestID || null;
      const merchantRequestId = stk.MerchantRequestID || null;
      const resultCode = stk.ResultCode;
      const resultDesc = stk.ResultDesc || null;
      const metaItems = stk.CallbackMetadata && stk.CallbackMetadata.Item ? stk.CallbackMetadata.Item : [];

      const amount = pickCallbackValue(metaItems, 'Amount');
      const mpesaReceiptNumber = pickCallbackValue(metaItems, 'MpesaReceiptNumber');
      const transactionDateRaw = pickCallbackValue(metaItems, 'TransactionDate');
      const phoneNumber = pickCallbackValue(metaItems, 'PhoneNumber');

      let transactionDate = null;
      if (transactionDateRaw) {
        const s = String(transactionDateRaw);
        const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (m) transactionDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString();
      }

      let status = 'failed';
      if (String(resultCode) === '0' || resultCode === 0) status = 'success';
      else if (String(resultCode) === '1032') status = 'cancelled';

      const transactionRecord = {
        checkout_request_id: checkoutRequestId,
        merchant_request_id: merchantRequestId,
        result_code: resultCode == null ? null : String(resultCode),
        result_desc: resultDesc,
        amount: amount == null ? null : Number(amount),
        mpesa_receipt_number: mpesaReceiptNumber == null ? null : String(mpesaReceiptNumber),
        transaction_date: transactionDate,
        phone_number: phoneNumber == null ? null : String(phoneNumber),
        status
      };

      try {
        await supabaseUpdateMpesaTransactionByCheckoutRequestId(checkoutRequestId, transactionRecord);
      } catch (updateErr) {
        console.warn('Callback update failed, attempting upsert:', updateErr.message);
        await supabaseUpsertMpesaTransaction(transactionRecord);
      }

      // Try to get order items from transaction metadata and deduct inventory
      if (status === 'success') {
        const url = getOptionalEnv('SUPABASE_URL');
        const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
        
        if (url && key) {
          // Get transaction metadata to find items
          const txResponse = await fetch(
            `${url}/rest/v1/mpesa_transactions?checkout_request_id=eq.${encodeURIComponent(checkoutRequestId)}&select=metadata`,
            {
              method: 'GET',
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          if (txResponse.ok) {
            const txData = await txResponse.json();
            if (txData && txData.length > 0 && txData[0].metadata) {
              const metadata = typeof txData[0].metadata === 'string' 
                ? JSON.parse(txData[0].metadata) 
                : txData[0].metadata;
              
              if (metadata && metadata.items) {
                await deductInventory(metadata.items, checkoutRequestId);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  }
};