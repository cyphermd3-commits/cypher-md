const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const WARP_DIR = '/tmp/warp-data';
const WGCF_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'wgcf.exe' : 'wgcf');
const WIREPROXY_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy');

const WGCF_PROFILE = path.join(WARP_DIR, 'wgcf-profile.conf');
const WIREPROXY_CONFIG = path.join(WARP_DIR, 'wireproxy.conf');
const WARP_READY = path.join(WARP_DIR, '.ready');

const PROXY_ADDR = 'socks5://127.0.0.1:1080';

function hasBinaries() {
  return fs.existsSync(WGCF_BIN) && fs.existsSync(WIREPROXY_BIN);
}

const SECRETS_CONF = '/etc/secrets/warp.conf';
const LOCAL_CONF = path.join(__dirname, '..', 'warp.conf');

function readSourceConfig() {
  return [SECRETS_CONF, LOCAL_CONF].find(f => fs.existsSync(f));
}

function hasSocks5Section(content) {
  return /^\[Socks5\]\s*$/m.test(content);
}

function normalizeNewlines(text) {
  let t = text;
  if (!/^\[/m.test(t) && /\\n/.test(t)) {
    console.log('[warp] config has no section headers — expanding literal \\\\n to newlines');
    t = t.replace(/\\n/g, '\n');
  }
  return t;
}

function hasInterfaceSection(content) {
  return /^\[Interface\]\s*$/m.test(content);
}

async function ensureRegistered() {
  if (fs.existsSync(WGCF_PROFILE) && fs.existsSync(WIREPROXY_CONFIG)) return;
  fs.mkdirSync(WARP_DIR, { recursive: true });

  // Always try wgcf register + generate first
  try {
    console.log('[warp] registering with Cloudflare WARP...');
    execFileSync(WGCF_BIN, ['register', '--accept-tos'], {
      cwd: WARP_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000
    });

    console.log('[warp] generating WireGuard config...');
    execFileSync(WGCF_BIN, ['generate'], {
      cwd: WARP_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000
    });
    console.log('[warp] wgcf config generated successfully');
    return;
  } catch (err) {
    console.warn('[warp] wgcf generation failed:', err.message);
    console.warn('[warp] falling back to pre-generated config...');
  }

  // Fallback: use pre-generated config from secret or local file
  const srcConf = [SECRETS_CONF, LOCAL_CONF].find(f => fs.existsSync(f));
  if (srcConf) {
    console.log('[warp] using pre-generated config from', srcConf);
    let raw = fs.readFileSync(srcConf, 'utf-8');
    raw = normalizeNewlines(raw);
    if (hasSocks5Section(raw)) {
      fs.writeFileSync(WIREPROXY_CONFIG, raw);
      console.log('[warp] config already has [Socks5] — using directly');
    } else if (hasInterfaceSection(raw)) {
      fs.writeFileSync(WGCF_PROFILE, raw);
      console.log('[warp] WireGuard config — converting to wireproxy format');
    } else {
      console.warn('[warp] WARP_CONF missing both [Interface] and [Socks5] sections');
      console.warn('[warp] first 200 chars:', JSON.stringify(raw.slice(0, 200)));
      console.warn('[warp] falling back to direct yt-dlp (no proxy)');
      return;
    }
    return;
  }

  throw new Error('wgcf registration failed and no pre-generated config found');
}

function createWireproxyConfig() {
  if (fs.existsSync(WIREPROXY_CONFIG)) return;
  const wgLines = fs.readFileSync(WGCF_PROFILE, 'utf-8');
  // Strip lines that wireproxy doesn't support (e.g. MTU in some versions)
  const filtered = wgLines.split(/\r?\n/).filter(line => {
    const key = line.split('=')[0]?.trim().toLowerCase();
    return !['mtu'].includes(key);
  }).join(os.EOL);
  const config = filtered + os.EOL + os.EOL + `[Socks5]
BindAddress = 127.0.0.1:1080
`;
  fs.writeFileSync(WIREPROXY_CONFIG, config);
}

function startProxy() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(WARP_READY)) {
      console.log('[warp] proxy already ready');
      process.env.YT_PROXY = PROXY_ADDR;
      return resolve();
    }

    console.log('[warp] starting wireproxy...');
    const proc = spawn(WIREPROXY_BIN, ['-c', WIREPROXY_CONFIG], {
      cwd: WARP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    const timeout = setTimeout(() => {
      console.log('[warp] proxy started (timeout)');
      fs.writeFileSync(WARP_READY, '1');
      process.env.YT_PROXY = PROXY_ADDR;
      resolve();
    }, 8000);

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      console.log('[warp] wireproxy:', text.trim());
      if (text.includes('Starting socks5') || text.includes('bound')) {
        clearTimeout(timeout);
        console.log('[warp] proxy ready');
        fs.writeFileSync(WARP_READY, '1');
        process.env.YT_PROXY = PROXY_ADDR;
        resolve();
      }
    });
    proc.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log('[warp] wireproxy:', text);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (!fs.existsSync(WARP_READY)) {
        clearTimeout(timeout);
        if (code === 0) {
          fs.writeFileSync(WARP_READY, '1');
          process.env.YT_PROXY = PROXY_ADDR;
          resolve();
        } else {
          reject(new Error(`wireproxy exited with code ${code}`));
        }
      }
    });
  });
}

async function start() {
  if (process.env.YT_PROXY) {
    console.log('[warp] using YT_PROXY from env:', process.env.YT_PROXY);
    return;
  }

  if (!hasBinaries()) {
    console.log('[warp] binaries not found, skipping WARP proxy setup');
    return;
  }

  try {
    await ensureRegistered();
    createWireproxyConfig();
    await startProxy();
    console.log('[warp] ✅ SOCKS5 proxy on', PROXY_ADDR);
  } catch (err) {
    console.error('[warp] ❌ setup failed:', err.message);
    console.log('[warp] .play will fall back to direct yt-dlp');
    console.log('[warp] to use a custom wireproxy config, set WARP_CONF secret or place warp.conf in project root');
  }
}

module.exports = { start, hasBinaries, PROXY_ADDR };
