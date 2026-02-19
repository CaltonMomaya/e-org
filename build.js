#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read the HTML file
const htmlPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// Replace environment variables
const replacements = {
  'SUPABASE_URL': process.env.SUPABASE_URL || 'https://rscmpjnxqzjuzdogbofg.supabase.co',
  'SUPABASE_ANON_KEY': process.env.SUPABASE_ANON_KEY || 'your-anon-key'
};

// Replace the window.__ENV configuration
const envConfig = Object.entries(replacements)
  .map(([key, value]) => `            ${key}: '${value}'`)
  .join(',\n');

const newEnvBlock = `        window.__ENV = window.__ENV || {
${envConfig}
        };`;

// Replace the existing window.__ENV block
const envBlockRegex = /window\.__ENV = window\.__ENV \|\| \{[^}]+\};/s;
html = html.replace(envBlockRegex, newEnvBlock.trim());

// Write the updated HTML
fs.writeFileSync(htmlPath, html);

console.log('Environment variables injected successfully!');
