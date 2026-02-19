#!/bin/bash

# Build script for Vercel deployment
# Injects environment variables into index.html

if [ -n "$SUPABASE_URL" ]; then
  sed -i "s|https://rscmpjnxqzjuzdogbofg.supabase.co|$SUPABASE_URL|g" index.html
fi

if [ -n "$SUPABASE_ANON_KEY" ]; then
  sed -i "s|your-anon-key|$SUPABASE_ANON_KEY|g" index.html
fi

echo "Environment variables injected successfully!"
