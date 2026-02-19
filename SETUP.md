# Setup Guide for BEEyond Trees E-commerce

## 🚀 Quick Setup

### 1. Environment Variables

Replace the placeholders in `.env.example` with your actual values:

```bash
# M-Pesa Configuration
MPESA_ENV=sandbox
MPESA_CONSUMER_KEY=your_mpesa_consumer_key
MPESA_CONSUMER_SECRET=your_mpesa_consumer_secret
MPESA_SHORTCODE=your_mpesa_shortcode
MPESA_PASSKEY=your_mpesa_passkey
MPESA_CALLBACK_URL=https://your-domain.vercel.app/api/mpesa/callback

# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### 2. Vercel Deployment

Add your secrets to Vercel:

```bash
# M-Pesa secrets
vercel secrets add mpesa_env sandbox
vercel secrets add mpesa_consumer_key your_mpesa_consumer_key
vercel secrets add mpesa_consumer_secret your_mpesa_consumer_secret
vercel secrets add mpesa_shortcode your_mpesa_shortcode
vercel secrets add mpesa_passkey your_mpesa_passkey

# Supabase secrets
vercel secrets add supabase_url your_supabase_url
vercel secrets add supabase_anon_key your_supabase_anon_key
vercel secrets add supabase_service_role_key your_supabase_service_role_key
```

### 3. Deploy

```bash
vercel --prod
```

## 🔧 STK Push Testing

Use the diagnostic tool to test your STK push setup:

```bash
# Set your environment variables
export MPESA_CONSUMER_KEY=your_key
export MPESA_CONSUMER_SECRET=your_secret
export MPESA_SHORTCODE=your_shortcode
export MPESA_PASSKEY=your_passkey
export MPESA_ENV=sandbox

# Run diagnostics
node test-stk.js
```

## 🐛 Common Issues & Solutions

### STK Push Fails

1. **Environment Mismatch**: Ensure `MPESA_ENV` matches your credentials
2. **Invalid Callback URL**: Must be a publicly accessible HTTPS URL
3. **Network Timeout**: Check internet connectivity and M-Pesa service status
4. **Invalid Credentials**: Verify consumer key/secret match the environment

### GitHub Push Issues

- Never commit secrets to git
- Use environment variables or secret management services
- The `.gitignore` file prevents accidental commits of `.env` files

### Database Issues

- Ensure Supabase URL and keys are correct
- Check that the `mpesa_transactions` table exists
- Verify CORS settings on Supabase

## 📱 Testing M-Pesa

For sandbox testing, use the Safaricom test number:
- Phone: `254708374149`
- Amount: `1` KES
- Any valid shortcode and passkey for sandbox

## 🔒 Security Best Practices

1. **Never commit secrets** to version control
2. **Use different keys** for development and production
3. **Rotate keys** regularly
4. **Monitor usage** of your API keys
5. **Use HTTPS** for all callbacks

## 📞 Support

If you encounter issues:

1. Check the diagnostic tool output
2. Verify all environment variables are set
3. Ensure M-Pesa services are operational
4. Check Vercel function logs for detailed errors
