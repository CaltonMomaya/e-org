#!/usr/bin/env node

/**
 * STK Push Diagnostic Tool
 * This script helps diagnose common STK push issues
 */

const https = require('https');
const http = require('http');

// Configuration
const config = {
  sandbox: {
    baseUrl: 'https://sandbox.safaricom.co.ke',
    oauthUrl: 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    stkUrl: 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
  },
  production: {
    baseUrl: 'https://api.safaricom.co.ke',
    oauthUrl: 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    stkUrl: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
  }
};

function makeRequest(url, options, data = null) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const req = protocol.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.setTimeout(30000); // 30 second timeout

    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function testOAuth(consumerKey, consumerSecret, environment = 'sandbox') {
  console.log(`\n🔐 Testing OAuth (${environment})...`);
  
  const env = config[environment];
  if (!env) {
    throw new Error(`Invalid environment: ${environment}`);
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  
  const options = {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await makeRequest(env.oauthUrl, options);
    
    console.log(`Status: ${response.statusCode}`);
    console.log(`Headers:`, JSON.stringify(response.headers, null, 2));
    console.log(`Body:`, response.body);

    if (response.statusCode === 200) {
      const data = JSON.parse(response.body);
      if (data.access_token) {
        console.log('✅ OAuth successful!');
        return data.access_token;
      } else {
        console.log('❌ OAuth response missing access_token');
        return null;
      }
    } else {
      console.log('❌ OAuth failed');
      return null;
    }
  } catch (error) {
    console.log('❌ OAuth error:', error.message);
    return null;
  }
}

async function testSTK(accessToken, shortcode, passkey, phone, amount, environment = 'sandbox') {
  console.log(`\n📱 Testing STK Push (${environment})...`);
  
  const env = config[environment];
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: 'https://httpbin.org/post', // Test callback URL
    AccountReference: 'TEST123',
    TransactionDesc: 'Test Payment'
  };

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  };

  try {
    const response = await makeRequest(env.stkUrl, options, JSON.stringify(payload));
    
    console.log(`Status: ${response.statusCode}`);
    console.log(`Headers:`, JSON.stringify(response.headers, null, 2));
    console.log(`Body:`, response.body);

    if (response.statusCode === 200) {
      const data = JSON.parse(response.body);
      if (data.ResponseCode === '0') {
        console.log('✅ STK push successful!');
        console.log(`CheckoutRequestID: ${data.CheckoutRequestID}`);
        console.log(`MerchantRequestID: ${data.MerchantRequestID}`);
      } else {
        console.log('❌ STK push rejected:', data.ResponseDescription);
      }
    } else {
      console.log('❌ STK push failed');
    }
  } catch (error) {
    console.log('❌ STK push error:', error.message);
  }
}

async function runDiagnostics() {
  console.log('🚀 M-Pesa STK Push Diagnostics');
  console.log('================================');

  // Get environment variables
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const environment = process.env.MPESA_ENV || 'sandbox';

  console.log('\n📋 Configuration Check:');
  console.log(`Environment: ${environment}`);
  console.log(`Consumer Key: ${consumerKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`Consumer Secret: ${consumerSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`Shortcode: ${shortcode || '❌ Missing'}`);
  console.log(`Passkey: ${passkey ? '✅ Set' : '❌ Missing'}`);

  if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
    console.log('\n❌ Missing required environment variables');
    process.exit(1);
  }

  // Test OAuth
  const accessToken = await testOAuth(consumerKey, consumerSecret, environment);
  
  if (accessToken) {
    // Test STK with sample data
    const testPhone = environment === 'sandbox' ? '254708374149' : '254712345678'; // Sandbox test number
    const testAmount = 1;
    
    await testSTK(accessToken, shortcode, passkey, testPhone, testAmount, environment);
  }

  console.log('\n🏁 Diagnostics complete');
}

// Run if called directly
if (require.main === module) {
  runDiagnostics().catch(console.error);
}

module.exports = {
  testOAuth,
  testSTK,
  runDiagnostics
};
