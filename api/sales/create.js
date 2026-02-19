const { json, getOptionalEnv } = require('../mpesa/utils');

module.exports = async (req, res) => {
  // CORS
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

    const orderId = String(body.orderId || '').trim();
    const customerName = String(body.customerName || '').trim();
    const customerEmail = String(body.customerEmail || '').trim();
    const customerPhone = String(body.customerPhone || '').trim();
    const deliveryAddress = String(body.deliveryAddress || '').trim();
    const location = body.location ? String(body.location).trim() : null;
    const mpesaPhone = String(body.mpesaPhone || '').trim();
    const totalAmount = Number(body.totalAmount);
    const items = Array.isArray(body.items) ? body.items : [];
    const checkoutRequestId = String(body.checkoutRequestId || '').trim();

    console.log('Received order data:', {
      orderId,
      customerName,
      customerEmail,
      customerPhone,
      deliveryAddress,
      location,
      mpesaPhone,
      totalAmount,
      itemsCount: items.length,
      checkoutRequestId
    });

    if (!orderId) throw new Error('orderId is required');
    if (!customerName) throw new Error('customerName is required');
    if (!customerPhone) throw new Error('customerPhone is required');
    if (!mpesaPhone) throw new Error('mpesaPhone is required');
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) throw new Error('totalAmount must be positive');
    if (items.length === 0) throw new Error('items must not be empty');

    const url = getOptionalEnv('SUPABASE_URL');
    const key = getOptionalEnv('SUPABASE_SERVICE_ROLE_KEY') || getOptionalEnv('SUPABASE_ANON_KEY');
    
    if (!url || !key) throw new Error('Supabase not configured');

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // First check if order already exists
    const checkResponse = await fetch(
      `${url}/rest/v1/store_front_sales?order_id=eq.${encodeURIComponent(orderId)}`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (checkResponse.ok) {
      const existingOrders = await checkResponse.json();
      if (existingOrders && existingOrders.length > 0) {
        console.log('Order already exists, returning success:', orderId);
        return res.status(200).json({ 
          success: true, 
          orderId,
          message: 'Order already exists'
        });
      }
    }

    // DEDUCT INVENTORY FIRST
    console.log('Deducting inventory for items:', items);
    let inventorySuccess = true;
    
    for (const item of items) {
      try {
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
            
            if (newStock < 0) {
              console.warn(`Insufficient stock for product ${item.id}: ${currentStock} < ${item.quantity}`);
              inventorySuccess = false;
            } else {
              // Update stock
              const updateResponse = await fetch(
                `${url}/rest/v1/products?id=eq.${item.id}`,
                {
                  method: 'PATCH',
                  headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                  },
                  body: JSON.stringify({ stock: newStock })
                }
              );
              
              if (!updateResponse.ok) {
                console.warn(`Failed to update stock for product ${item.id}`);
              } else {
                console.log(`Updated stock for product ${item.id}: ${currentStock} -> ${newStock}`);
              }
            }
          }
        }
      } catch (stockErr) {
        console.error('Error updating stock for item:', item.id, stockErr);
      }
    }

    // 1. Insert into store_front_sales
    const saleRow = {
      order_id: orderId,
      customer_name: customerName,
      customer_email: customerEmail || '',
      customer_phone: customerPhone,
      delivery_address: deliveryAddress || '',
      location: location,
      mpesa_phone: mpesaPhone,
      total_amount: totalAmount,
      status: 'paid',
      payment_method: 'M-Pesa',
      order_type: 'store_front_sale'
    };

    console.log('Inserting sale:', JSON.stringify(saleRow));
    
    const saleResp = await fetch(`${url}/rest/v1/store_front_sales`, {
      method: 'POST',
      headers,
      body: JSON.stringify(saleRow)
    });

    const saleResponseText = await saleResp.text();
    console.log(`Sale insert response: ${saleResp.status} - ${saleResponseText}`);

    if (!saleResp.ok) {
      if (saleResponseText.includes('duplicate key') || saleResponseText.includes('unique constraint')) {
        console.log('Order already exists (duplicate key), returning success:', orderId);
        return res.status(200).json({ 
          success: true, 
          orderId,
          message: 'Order already exists'
        });
      }
      throw new Error(`Failed to create sale: ${saleResp.status} - ${saleResponseText}`);
    }

    // 2. Insert into store_front_sale_items
    const itemRows = items.map((item) => ({
      order_id: orderId,
      product_id: item.id || null,
      product_name: String(item.name || ''),
      quantity: Number(item.quantity) || 1,
      unit_price: Number(item.unitPrice) || 0,
      price_type: String(item.priceType || 'retail'),
      tier_label: String(item.tierLabel || 'Retail'),
      total_price: Number(item.price) || (Number(item.unitPrice || 0) * Number(item.quantity || 1))
    }));

    console.log('Inserting items:', JSON.stringify(itemRows));

    const itemsResp = await fetch(`${url}/rest/v1/store_front_sale_items`, {
      method: 'POST',
      headers,
      body: JSON.stringify(itemRows)
    });

    if (!itemsResp.ok) {
      const itemsResponseText = await itemsResp.text();
      console.error(`store_front_sale_items insert failed: ${itemsResp.status} ${itemsResponseText}`);
    }

    // 3. Link mpesa_transactions.order_id to this sale
    if (checkoutRequestId) {
      try {
        const patchResp = await fetch(
          `${url}/rest/v1/mpesa_transactions?checkout_request_id=eq.${encodeURIComponent(checkoutRequestId)}`,
          {
            method: 'PATCH',
            headers: {
              ...headers,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ order_id: orderId, updated_at: new Date().toISOString() })
          }
        );
        
        if (!patchResp.ok) {
          console.warn('Failed to link transaction to order');
        }
      } catch (linkErr) {
        console.warn('Failed to link mpesa_transaction to order:', linkErr.message);
      }
    }

    res.statusCode = 200;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 
      success: true, 
      orderId,
      message: 'Order created successfully',
      inventoryUpdated: inventorySuccess
    }));
    
  } catch (e) {
    console.error('Create order error:', e);
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