// One-click test launcher: starts Ding and opens a temporary public https link
// (via Cloudflare's free quick tunnel) so you can scan the QR with a real phone.
'use strict';
const { spawn, exec } = require('child_process');

process.env.PORT = process.env.PORT || '3000';
process.env.SHOP_NAME = process.env.SHOP_NAME || 'Café Saida';
require('./server'); // starts the app on http://localhost:3000

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

console.log('\nStarting the secure public link (first time downloads Cloudflare\'s tunnel tool, ~30 seconds)...\n');
const tunnel = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${process.env.PORT}`], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let opened = false;
function scan(chunk) {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !opened) {
    opened = true;
    const url = m[0];
    console.log('\n==============================================================');
    console.log('  READY. Counter screen (open this, NOT localhost):');
    console.log(`  ${url}`);
    console.log('  Create an order there and scan the QR with your phone.');
    console.log('  Keep this window open while testing. Close it to stop.');
    console.log('==============================================================\n');
    setTimeout(() => openBrowser(url), 4000); // give the tunnel a moment to go live
  }
  if (/error|failed/i.test(text) && !opened) process.stdout.write(text);
}
tunnel.stdout.on('data', scan);
tunnel.stderr.on('data', scan);
tunnel.on('exit', (code) => {
  if (!opened) {
    console.log('\nThe public link could not start (code ' + code + ').');
    console.log('The app still works on this computer: http://localhost:' + process.env.PORT);
  }
});
process.on('SIGINT', () => { tunnel.kill(); process.exit(0); });
