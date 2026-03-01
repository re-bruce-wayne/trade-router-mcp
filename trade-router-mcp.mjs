#!/usr/bin/env node
/**
 * traderouter.ai MCP Server (JavaScript)
 * Solana swap & limit order engine — REST + persistent WebSocket
 *
 * Equivalent to trader_mcp.py. Same tools, same auth flow, same
 * server_signature verification logic as the website examples.
 *
 * Barebone setup (minimum required):
 *   pnpm add @modelcontextprotocol/sdk @solana/web3.js bs58 tweetnacl ws node-fetch
 *
 * Run (stdio transport, for Claude Desktop / claude-code):
 *   TRADEROUTER_PRIVATE_KEY=<base58> node traderouter-mcp.mjs
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "traderouter": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/traderouter-mcp.mjs"],
 *         "env": { "TRADEROUTER_PRIVATE_KEY": "YOUR_KEY" }
 *       }
 *     }
 *   }
 */

import { Server }       from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Keypair, Connection } from '@solana/web3.js';
import { VersionedTransaction } from '@solana/web3.js';
import bs58   from 'bs58';
import nacl   from 'tweetnacl';
import WebSocket from 'ws';
import { createHash } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE   = 'https://api.traderouter.ai';
const WS_URL     = 'wss://api.traderouter.ai/ws';
const RPC_URL    = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const PRIVATE_KEY_B58 = process.env.TRADEROUTER_PRIVATE_KEY || '';

// Trust anchor — hardcoded, never fetched from server (TOCTOU)
const _HARDCODED_SERVER_PUBKEY = 'EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4';
const SERVER_PUBKEY_B58      = (process.env.TRADEROUTER_SERVER_PUBKEY || _HARDCODED_SERVER_PUBKEY).trim();
const SERVER_PUBKEY_NEXT_B58 = (process.env.TRADEROUTER_SERVER_PUBKEY_NEXT || '').trim() || null;
const REQUIRE_SERVER_SIG     = (process.env.TRADEROUTER_REQUIRE_SERVER_SIGNATURE || 'true') === 'true';
const REQUIRE_ORDER_CREATED_SIG = (process.env.TRADEROUTER_REQUIRE_ORDER_CREATED_SIGNATURE || 'true') === 'true';

const BACKOFF_BASE   = 1000;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX    = 60000;
const BACKOFF_JITTER = 0.25;

const WS_STARTUP_WAIT_MS = 25000;

// ── Solana helpers ───────────────────────────────────────────────────────────

function getKeypair() {
  if (!PRIVATE_KEY_B58) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
  } catch (e) {
    throw new Error(`Invalid TRADEROUTER_PRIVATE_KEY: ${e.message}`);
  }
}

function signTxB58(swapTxB58) {
  const kp = getKeypair();
  if (!kp) throw new Error('TRADEROUTER_PRIVATE_KEY not set — cannot auto-sign');
  const raw    = bs58.decode(swapTxB58);
  const tx     = VersionedTransaction.deserialize(raw);
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString('base64');
}

// ── REST helpers ─────────────────────────────────────────────────────────────

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body) {
  const timeoutMs = path.includes('holdings') ? 110000 : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Signature verification ────────────────────────────────────────────────────

const CANONICAL_KEYS = [
  'order_id', 'order_type', 'status', 'token_address',
  'entry_mcap', 'triggered_mcap', 'filled_mcap', 'target_mcap',
  'triggered_at', 'filled_at', 'data',
];

function canonicalizeForSigning(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForSigning);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeForSigning(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJsonPythonStyle(obj) {
  // Match Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
  const canonicalObj = canonicalizeForSigning(obj);
  const json = JSON.stringify(canonicalObj);
  return json.replace(/[^\x00-\x7F]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function verifyOrderFilled(msg, serverPubkeyB58) {
  if (!serverPubkeyB58) return false;
  const sigB58 = msg.server_signature;
  if (!sigB58) return false;

  const payload = {};
  for (const key of CANONICAL_KEYS) {
    if (msg[key] !== undefined && msg[key] !== null) payload[key] = msg[key];
  }
  const canonical = canonicalJsonPythonStyle(payload);
  const digest    = createHash('sha256').update(Buffer.from(canonical, 'utf-8')).digest();

  try {
    const sigBytes    = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(serverPubkeyB58);
    return nacl.sign.detached.verify(digest, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

function verifyOrderFilledWithRotation(msg) {
  const keys = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    if (verifyOrderFilled(msg, key)) {
      if (key === SERVER_PUBKEY_NEXT_B58) {
        log('warn', 'Fill verified with NEXT server key — update TRADEROUTER_SERVER_PUBKEY');
      }
      return true;
    }
  }
  return false;
}

// twap_execution: server signs order_id|order_type|execution_num|executions_total|status|token_address (SHA-256 then Ed25519)
function verifyTwapExecution(msg, serverPubkeyB58) {
  if (!serverPubkeyB58) return false;
  const sigB58 = msg.server_signature;
  if (!sigB58) return false;
  const { order_id, order_type, execution_num, executions_total, status, token_address } = msg;
  if (order_id == null || order_type == null || execution_num == null || executions_total == null || status == null || token_address == null) return false;
  const s = `${order_id}|${order_type}|${execution_num}|${executions_total}|${status}|${token_address}`;
  const digest = createHash('sha256').update(Buffer.from(s, 'utf-8')).digest();
  try {
    const sigBytes = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(serverPubkeyB58);
    return nacl.sign.detached.verify(digest, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

function verifyTwapExecutionWithRotation(msg) {
  const keys = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    if (verifyTwapExecution(msg, key)) return true;
  }
  return false;
}

function computeParamsHash(msg) {
  const { order_id, token_address, order_type, slippage, expiry_hours, amount } = msg;
  if (!order_id || !token_address || !order_type || slippage == null || expiry_hours == null || amount == null) {
    return null;
  }
  const hp = msg.holdings_percentage != null ? parseInt(msg.holdings_percentage) : 0;
  let bpsField;
  if (['sell', 'buy'].includes(order_type)) {
    if (msg.target_bps == null) return null;
    bpsField = parseInt(msg.target_bps);
  } else if (['trailing_sell', 'trailing_buy'].includes(order_type)) {
    if (msg.trail_bps == null) return null;
    bpsField = parseInt(msg.trail_bps);
  } else {
    return null;
  }
  const s = `${order_id}|${token_address}|${order_type}|${bpsField}|${parseInt(slippage)}|${parseInt(expiry_hours)}|${parseInt(amount)}|${hp}`;
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

function verifyOrderCreated(msg) {
  const paramsHash = msg.params_hash;
  const sigB58     = msg.server_signature;
  if (!paramsHash || !sigB58) return null;  // server hasn't shipped commitment yet
  const computed = computeParamsHash(msg);
  if (!computed || computed !== paramsHash) return false;
  const digest = createHash('sha256').update(Buffer.from(paramsHash, 'utf-8')).digest();
  const keys   = [SERVER_PUBKEY_B58, SERVER_PUBKEY_NEXT_B58].filter(Boolean);
  for (const key of keys) {
    try {
      const ok = nacl.sign.detached.verify(digest, bs58.decode(sigB58), bs58.decode(key));
      if (ok) return true;
    } catch { /* try next */ }
  }
  return false;
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, ...args) {
  process.stderr.write(`[traderouter] ${level.toUpperCase()} ${args.join(' ')}\n`);
}

// ── WsManager ────────────────────────────────────────────────────────────────

class WsManager {
  constructor(wallet) {
    this.wallet      = wallet;
    this._ws         = null;
    this._registered = false;
    this._attempt    = 0;
    this._stopped    = false;

    // Pending: [{payload, resolve, reject, expectType}]
    this._pending  = [];
    // Inflight: {expectType: [{resolve, reject, ts}]}
    this._inflight = {};

    this._fillLog       = [];
    this._registeredCbs = [];   // callbacks for when registered fires
  }

  start() {
    this._stopped = false;
    this._loop();
  }

  async stop() {
    this._stopped = true;
    if (this._ws) try { this._ws.close(); } catch {}
    this._ws = null;
    this._registered = false;
    this._failAllInflight(new Error('WsManager stopped'));
  }

  get isConnected() { return this._registered && this._ws != null; }

  status() {
    return {
      connected:      this.isConnected,
      attempt:        this._attempt,
      pending_sends:  this._pending.length,
      inflight:       Object.fromEntries(Object.entries(this._inflight).map(([k, v]) => [k, v.length])),
      fill_log_count: this._fillLog.length,
    };
  }

  getFillLog() { return [...this._fillLog]; }

  waitRegistered(timeoutMs = 20000) {
    if (this._registered) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this._registeredCbs.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  sendAndWait(payload, expectType, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Timeout waiting for '${expectType}' (${this.isConnected ? 'server no response' : 'not connected — queued'})`
      )), timeoutMs);

      const wrappedResolve = (v) => { clearTimeout(timer); resolve(v); };
      const wrappedReject  = (e) => { clearTimeout(timer); reject(e); };

      if (this._registered && this._ws) {
        try {
          this._ws.send(JSON.stringify(payload));
          this._inflight[expectType] = this._inflight[expectType] || [];
          this._inflight[expectType].push({ resolve: wrappedResolve, reject: wrappedReject, ts: Date.now() });
        } catch {
          this._pending.push({ payload, resolve: wrappedResolve, reject: wrappedReject, expectType });
        }
      } else {
        this._pending.push({ payload, resolve: wrappedResolve, reject: wrappedReject, expectType });
      }
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _loop() {
    while (!this._stopped) {
      try {
        await this._connect();
        this._attempt = 0;
      } catch (e) {
        if (this._stopped) break;
        this._attempt++;
        const raw    = BACKOFF_BASE * Math.pow(BACKOFF_FACTOR, this._attempt - 1);
        const capped = Math.min(raw, BACKOFF_MAX);
        const jitter = capped * BACKOFF_JITTER * (2 * Math.random() - 1);
        const wait   = Math.max(500, capped + jitter);
        log('warn', `WS error (attempt ${this._attempt}): ${e.message} — retrying in ${(wait/1000).toFixed(1)}s`);
        this._registered = false;
        this._ws = null;
        this._failAllInflight(new Error(`WebSocket disconnected: ${e.message}`));
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      log('info', `Connecting to ${WS_URL}`);
      const ws = new WebSocket(WS_URL);
      this._ws = ws;

      ws.on('open',    ()  => log('info', 'WebSocket connected'));
      ws.on('error',   (e) => reject(e));
      ws.on('close',   ()  => reject(new Error('WebSocket closed')));
      ws.on('message', (raw) => {
        try {
          this._dispatch(JSON.parse(raw), resolve, reject);
        } catch (e) {
          log('error', `Dispatch error: ${e.message}`);
        }
      });
    });
  }

  _dispatch(msg, resolveConn, rejectConn) {
    const t = msg.type;

    if (t === 'challenge') {
      const kp = getKeypair();
      if (!kp || !msg.nonce) {
        log('warn', 'challenge received but no nonce or TRADEROUTER_PRIVATE_KEY — cannot register');
        return;
      }
      const sigBytes  = nacl.sign.detached(Buffer.from(msg.nonce, 'utf-8'), kp.secretKey);
      const signature = bs58.encode(sigBytes);
      this._ws.send(JSON.stringify({
        action: 'register',
        wallet_address: this.wallet,
        signature,
      }));
      log('info', `→ challenge; sent register with signature for …${this.wallet.slice(-6)}`);
    }

    else if (t === 'registered') {
      if (!msg.authenticated) {
        log('error', `registered but authenticated: false for …${this.wallet.slice(-6)} — check TRADEROUTER_PRIVATE_KEY matches wallet_address`);
        return;
      }
      log('info', `✓ registered; flushing ${this._pending.length} pending send(s)`);
      this._registered = true;
      this._attempt    = 0;
      this._registeredCbs.forEach(cb => cb());
      this._registeredCbs = [];
      this._flushPending();
    }

    else if (t === 'heartbeat') { /* ignore */ }

    else if (t === 'order_filled') {
      log('info', `→ order_filled order_id=${msg.order_id}`);
      this._handleFill(msg);
    }

    else if (t === 'twap_order_created') {
      this._resolveInflight(t, msg);
    }

    else if (t === 'twap_execution') {
      log('info', `→ twap_execution order_id=${msg.order_id} execution=${msg.execution_num}/${msg.executions_total}`);
      this._handleTwapExecution(msg);
    }

    else if (t === 'twap_order_completed') {
      log('info', `→ twap_order_completed order_id=${msg.order_id} executions=${msg.executions_completed}`);
      this._resolveInflight(t, msg);
    }

    else if (t === 'twap_order_cancelled') {
      this._resolveInflight(t, msg);
      this._resolveInflight('order_cancelled', msg);  // so cancel_order call receives a response
    }

    else if (t === 'error') {
      log('error', `← server error: ${msg.message}`);
      const first = this._firstInflight();
      if (first) first.reject(new Error(msg.message));
    }

    else if (t === 'order_created') {
      const hasCommitment = !!(msg.params_hash && msg.server_signature);
      msg.params_verified = hasCommitment ? verifyOrderCreated(msg) : null;
      if (hasCommitment && !msg.params_verified) {
        const errMsg = `order_created params commitment FAILED order_id=${msg.order_id}`;
        log('error', errMsg);
        const first = this._firstInflight();
        if (first) first.reject(new Error(errMsg));
        return;
      }
      if (!hasCommitment && REQUIRE_ORDER_CREATED_SIG) {
        const errMsg = `order_created missing params commitment — rejecting order_id=${msg.order_id}`;
        log('error', errMsg);
        const first = this._firstInflight();
        if (first) first.reject(new Error(errMsg));
        return;
      }
      this._resolveInflight(t, msg);
    }

    else {
      this._resolveInflight(t, msg);
    }
  }

  async _handleFill(msg) {
    const entry = { fill: msg, protect: null, error: null, ts: Date.now() / 1000 };

    if (msg.already_dispatched) {
      log('info', `order_filled already_dispatched order_id=${msg.order_id} — skipping`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const sigB58 = msg.server_signature;
    if (sigB58) {
      if (!SERVER_PUBKEY_B58 && !SERVER_PUBKEY_NEXT_B58) {
        entry.error = 'server_signature present but no server public key configured';
        log('error', `order_filled has server_signature but no pubkey configured — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      if (!verifyOrderFilledWithRotation(msg)) {
        entry.error = 'server_signature verification failed';
        log('error', `order_filled server_signature FAILED — rejecting fill ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
    } else {
      if (REQUIRE_SERVER_SIG) {
        entry.error = 'no server_signature present';
        log('error', `order_filled has no server_signature — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      log('warn', `order_filled has no server_signature — proceeding (REQUIRE_SERVER_SIGNATURE=false) ${msg.order_id}`);
    }

    const swapTx = msg.data?.swap_tx;
    if (!swapTx) {
      log('warn', `order_filled with no swap_tx — stored only`);
    } else if (!PRIVATE_KEY_B58) {
      log('info', `Fill received; no private key set — stored in fill_log only`);
    } else {
      try {
        const signedB64 = signTxB58(swapTx);
        const protect   = await post('/protect', { signed_tx_base64: signedB64 });
        entry.protect   = protect;
        log('info', `Auto-submitted fill ${msg.order_id} → sig ${(protect.signature || '?').slice(0, 16)}…`);
      } catch (e) {
        entry.error = e.message;
        log('error', `Auto-submit failed for fill ${msg.order_id}: ${e.message}`);
      }
    }

    this._fillLog.push(entry);
    if (this._fillLog.length > 200) this._fillLog.shift();
  }

  async _handleTwapExecution(msg) {
    const entry = { fill: msg, protect: null, error: null, ts: Date.now() / 1000 };

    if (msg.status === 'error') {
      log('warn', `twap_execution error order_id=${msg.order_id} execution=${msg.execution_num}: ${msg.error || 'unknown'}`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const sigB58 = msg.server_signature;
    if (sigB58) {
      if (!SERVER_PUBKEY_B58 && !SERVER_PUBKEY_NEXT_B58) {
        entry.error = 'server_signature present but no server public key configured';
        log('error', `twap_execution has server_signature but no pubkey configured — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
      if (!verifyTwapExecutionWithRotation(msg)) {
        entry.error = 'server_signature verification failed';
        log('error', `twap_execution server_signature FAILED — rejecting ${msg.order_id}`);
        this._fillLog.push(entry);
        if (this._fillLog.length > 200) this._fillLog.shift();
        return;
      }
    } else if (REQUIRE_SERVER_SIG) {
      entry.error = 'no server_signature present';
      log('error', `twap_execution has no server_signature — rejecting ${msg.order_id}`);
      this._fillLog.push(entry);
      if (this._fillLog.length > 200) this._fillLog.shift();
      return;
    }

    const swapTx = msg.data?.swap_tx;
    if (!swapTx) {
      log('warn', `twap_execution with no swap_tx — stored only`);
    } else if (!PRIVATE_KEY_B58) {
      log('info', `TWAP slice received; no private key set — stored in fill_log only`);
    } else {
      try {
        const signedB64 = signTxB58(swapTx);
        const protect = await post('/protect', { signed_tx_base64: signedB64 });
        entry.protect = protect;
        log('info', `Auto-submitted TWAP slice ${msg.order_id} #${msg.execution_num} → sig ${(protect.signature || '?').slice(0, 16)}…`);
      } catch (e) {
        entry.error = e.message;
        log('error', `Auto-submit failed for TWAP slice ${msg.order_id} #${msg.execution_num}: ${e.message}`);
      }
    }

    this._fillLog.push(entry);
    if (this._fillLog.length > 200) this._fillLog.shift();
  }

  _flushPending() {
    const queue = [...this._pending];
    this._pending = [];
    for (const item of queue) {
      try {
        this._ws.send(JSON.stringify(item.payload));
        this._inflight[item.expectType] = this._inflight[item.expectType] || [];
        this._inflight[item.expectType].push({ resolve: item.resolve, reject: item.reject, ts: Date.now() });
      } catch {
        this._pending.unshift(item);
        break;
      }
    }
  }

  _resolveInflight(type, msg) {
    const waiters = this._inflight[type];
    if (waiters?.length) {
      const { resolve } = waiters.shift();
      resolve(msg);
    }
  }

  _firstInflight() {
    for (const waiters of Object.values(this._inflight)) {
      if (waiters.length) return waiters[0];
    }
    return null;
  }

  _failAllInflight(err) {
    for (const waiters of Object.values(this._inflight)) {
      for (const { reject } of waiters) reject(err);
    }
    this._inflight = {};
  }
}

// ── Manager registry ─────────────────────────────────────────────────────────

const _managers = new Map();

function getManager(wallet) {
  if (!_managers.has(wallet)) {
    const mgr = new WsManager(wallet);
    _managers.set(wallet, mgr);
    mgr.start();
  }
  return _managers.get(wallet);
}

async function getManagerRegistered(wallet, timeoutMs = WS_STARTUP_WAIT_MS) {
  const mgr = getManager(wallet);
  if (PRIVATE_KEY_B58 && !mgr.isConnected) {
    const kp = getKeypair();
    if (kp && kp.publicKey.toBase58() === wallet) {
      log('info', `Waiting up to ${timeoutMs / 1000}s for WS registration…`);
      const ok = await mgr.waitRegistered(timeoutMs);
      if (!ok) log('warn', `WS did not register within ${timeoutMs / 1000}s — command may be queued`);
    }
  }
  return mgr;
}

async function ws(wallet, payload, expectType, timeoutMs = 15000) {
  const mgr = await getManagerRegistered(wallet);
  try {
    return await mgr.sendAndWait(payload, expectType, timeoutMs);
  } catch (e) {
    if (e.message.includes('Timeout')) throw e;
    throw e;
  }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'traderouter', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_wallet_address',
    description: 'Derive the Solana wallet address from TRADEROUTER_PRIVATE_KEY. Call first at session start — also starts WebSocket connection.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'build_swap',
    description: 'Build an unsigned Solana swap tx via REST. Returns base58 swap_tx. Pass to submit_signed_swap or use auto_swap.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action'],
      properties: {
        wallet_address: { type: 'string' },
        token_address:  { type: 'string' },
        action:         { type: 'string', enum: ['buy', 'sell'] },
        amount:              { type: 'integer', description: 'Lamports (buy only)' },
        holdings_percentage: { type: 'integer', description: 'Bps (sell only, 10000=100%)' },
        slippage:       { type: 'integer', minimum: 100, maximum: 2500, default: 1500 },
      },
    },
  },
  {
    name: 'submit_signed_swap',
    description: 'Submit a base64-encoded signed Solana transaction via MEV-protected lane.',
    inputSchema: {
      type: 'object',
      required: ['signed_tx_base64'],
      properties: { signed_tx_base64: { type: 'string' } },
    },
  },
  {
    name: 'auto_swap',
    description: 'Build + sign + submit in one step. Requires TRADEROUTER_PRIVATE_KEY.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action'],
      properties: {
        wallet_address: { type: 'string' },
        token_address:  { type: 'string' },
        action:         { type: 'string', enum: ['buy', 'sell'] },
        amount:              { type: 'integer' },
        holdings_percentage: { type: 'integer' },
        slippage:       { type: 'integer', minimum: 100, maximum: 2500, default: 1500 },
      },
    },
  },
  {
    name: 'get_holdings',
    description: 'Scan SPL token holdings for a Solana wallet. Slow — up to 100s.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      properties: { wallet_address: { type: 'string' } },
    },
  },
  {
    name: 'get_mcap',
    description: 'Get market cap (and price/pool) data for one or more token addresses. GET /mcap.',
    inputSchema: {
      type: 'object',
      required: ['tokens'],
      properties: {
        tokens: { type: 'string', description: 'Comma-separated Solana mint addresses' },
      },
    },
  },
  {
    name: 'get_flex_card',
    description: 'Get the URL for a flex trade card PNG for a wallet and token. GET /flex. Returns the URL to display the image.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address'],
      properties: {
        wallet_address: { type: 'string' },
        token_address: { type: 'string' },
      },
    },
  },
  {
    name: 'connect_websocket',
    description: 'Connect WS for a wallet and wait until registered (up to 25s). Call before placing orders.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      properties: { wallet_address: { type: 'string' } },
    },
  },
  {
    name: 'connection_status',
    description: 'Return live WS connection state for a wallet.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      properties: { wallet_address: { type: 'string' } },
    },
  },
  {
    name: 'get_fill_log',
    description: 'Return all order_filled events received since process start (capped at 200).',
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      properties: { wallet_address: { type: 'string' } },
    },
  },
  {
    name: 'place_limit_order',
    description: 'Place a market-cap-based limit order over WS. action: sell|buy. target: bps vs current mcap at placement.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'target'],
      properties: {
        wallet_address:      { type: 'string' },
        token_address:       { type: 'string' },
        action:              { type: 'string', enum: ['sell', 'buy'] },
        target:              { type: 'integer', minimum: 1 },
        amount:              { type: 'integer' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000 },
        slippage:            { type: 'integer', minimum: 100, maximum: 2500, default: 1500 },
        expiry_hours:        { type: 'integer', minimum: 1, maximum: 336, default: 144 },
      },
    },
  },
  {
    name: 'place_trailing_order',
    description: 'Place a trailing stop or trailing buy over WS. action: trailing_sell|trailing_buy. trail: bps distance.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'trail'],
      properties: {
        wallet_address:      { type: 'string' },
        token_address:       { type: 'string' },
        action:              { type: 'string', enum: ['trailing_sell', 'trailing_buy'] },
        trail:               { type: 'integer', minimum: 1 },
        amount:              { type: 'integer' },
        holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000 },
        slippage:            { type: 'integer', minimum: 100, maximum: 2500, default: 1500 },
        expiry_hours:        { type: 'integer', minimum: 1, maximum: 336, default: 144 },
      },
    },
  },
  {
    name: 'place_twap_order',
    description: 'Place a TWAP (time-weighted) buy or sell order. Splits total quantity into frequency slices over duration seconds. action: twap_buy|twap_sell.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'token_address', 'action', 'frequency', 'duration'],
      properties: {
        wallet_address:       { type: 'string' },
        token_address:        { type: 'string' },
        action:               { type: 'string', enum: ['twap_buy', 'twap_sell'] },
        frequency:            { type: 'integer', minimum: 1, maximum: 100, description: 'Number of executions' },
        duration:             { type: 'integer', minimum: 60, description: 'Total run time in seconds (max 30 days)' },
        quantity:             { type: 'integer', description: 'Total lamports (buy) or raw token units (sell)' },
        holdings_percentage:  { type: 'integer', minimum: 1, maximum: 10000, description: 'Sell only: bps of holdings at creation' },
        slippage:             { type: 'integer', minimum: 100, maximum: 2500, default: 500 },
      },
    },
  },
  {
    name: 'list_orders',
    description: 'List all active limit/trailing orders for a wallet.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address'],
      properties: { wallet_address: { type: 'string' } },
    },
  },
  {
    name: 'check_order',
    description: 'Check the status of a specific order by order_id.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id'],
      properties: {
        wallet_address: { type: 'string' },
        order_id:       { type: 'string' },
      },
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel an active limit or trailing order.',
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id'],
      properties: {
        wallet_address: { type: 'string' },
        order_id:       { type: 'string' },
      },
    },
  },
  {
    name: 'extend_order',
    description: "Extend an order's expiry. expiry_hours is the new total (1–336).",
    inputSchema: {
      type: 'object',
      required: ['wallet_address', 'order_id', 'expiry_hours'],
      properties: {
        wallet_address: { type: 'string' },
        order_id:       { type: 'string' },
        expiry_hours:   { type: 'integer', minimum: 1, maximum: 336 },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool dispatch ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    const result = await callTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
      isError: true,
    };
  }
});

async function callTool(name, args) {
  switch (name) {

    case 'get_wallet_address': {
      if (!PRIVATE_KEY_B58) return { configured: false, error: 'TRADEROUTER_PRIVATE_KEY not set' };
      const kp     = getKeypair();
      const wallet = kp.publicKey.toBase58();
      getManager(wallet);   // kick off WS connection
      return { configured: true, wallet_address: wallet };
    }

    case 'build_swap': {
      const { wallet_address, token_address, action, amount, holdings_percentage, slippage = 1500 } = args;
      if (!['buy', 'sell'].includes(action)) return { error: "action must be 'buy' or 'sell'" };
      if (action === 'buy'  && !amount)              return { error: 'amount (lamports) required for buy' };
      if (action === 'sell' && !holdings_percentage) return { error: 'holdings_percentage required for sell' };
      if (slippage < 100 || slippage > 2500)         return { error: 'slippage must be 100–2500 bps' };
      const body = { wallet_address, token_address, action, slippage };
      if (action === 'buy')  body.amount = amount;
      else body.holdings_percentage = holdings_percentage;
      return await post('/swap', body);
    }

    case 'submit_signed_swap': {
      return await post('/protect', { signed_tx_base64: args.signed_tx_base64 });
    }

    case 'auto_swap': {
      const swap = await callTool('build_swap', args);
      if (swap.error || swap.status !== 'success') return swap;
      const signedB64 = signTxB58(swap.data.swap_tx);
      const protect   = await post('/protect', { signed_tx_base64: signedB64 });
      return { swap: swap.data, protect };
    }

    case 'get_holdings': {
      return await post('/holdings', { wallet_address: args.wallet_address });
    }

    case 'get_mcap': {
      const tokens = typeof args.tokens === 'string' ? args.tokens : (args.tokens || []).join(',');
      if (!tokens.trim()) return { error: 'tokens (comma-separated) required' };
      return await get('/mcap', { tokens: tokens.trim() });
    }

    case 'get_flex_card': {
      const { wallet_address, token_address } = args;
      if (!wallet_address || !token_address) return { error: 'wallet_address and token_address required' };
      const url = `${API_BASE}/flex?wallet_address=${encodeURIComponent(wallet_address)}&token_address=${encodeURIComponent(token_address)}`;
      return { url, wallet_address, token_address };
    }

    case 'connect_websocket': {
      const mgr = await getManagerRegistered(args.wallet_address);
      return {
        wallet:  args.wallet_address,
        message: mgr.isConnected ? 'WebSocket connected and registered' : 'WebSocket not yet registered; commands may be queued',
        ...mgr.status(),
      };
    }

    case 'connection_status': {
      const mgr = getManager(args.wallet_address);
      return { wallet: args.wallet_address, ...mgr.status() };
    }

    case 'get_fill_log': {
      const mgr = getManager(args.wallet_address);
      return { wallet: args.wallet_address, fills: mgr.getFillLog() };
    }

    case 'place_limit_order': {
      const { wallet_address, token_address, action, target, amount, holdings_percentage, slippage = 1500, expiry_hours = 144 } = args;
      if (!['sell', 'buy'].includes(action))    return { error: "action must be 'sell' or 'buy'" };
      if (action === 'sell' && !holdings_percentage) return { error: 'holdings_percentage required for sell' };
      if (action === 'buy'  && !amount)              return { error: 'amount required for buy' };
      if (!target || target <= 0)                return { error: 'target must be > 0' };
      if (slippage < 100 || slippage > 2500)     return { error: 'slippage must be 100–2500 bps' };
      if (expiry_hours < 1 || expiry_hours > 336) return { error: 'expiry_hours must be 1–336' };
      const payload = { action, token_address, target, slippage, expiry_hours };
      if (action === 'sell') payload.holdings_percentage = holdings_percentage;
      else payload.amount = amount;
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_trailing_order': {
      const { wallet_address, token_address, action, trail, amount, holdings_percentage, slippage = 1500, expiry_hours = 144 } = args;
      if (!['trailing_sell', 'trailing_buy'].includes(action)) return { error: "action must be 'trailing_sell' or 'trailing_buy'" };
      if (action === 'trailing_sell' && !holdings_percentage)  return { error: 'holdings_percentage required for trailing_sell' };
      if (action === 'trailing_buy'  && !amount)               return { error: 'amount required for trailing_buy' };
      if (!trail || trail <= 0)                    return { error: 'trail must be > 0' };
      if (slippage < 100 || slippage > 2500)       return { error: 'slippage must be 100–2500 bps' };
      if (expiry_hours < 1 || expiry_hours > 336)  return { error: 'expiry_hours must be 1–336' };
      const payload = { action, token_address, trail, slippage, expiry_hours };
      if (action === 'trailing_sell') payload.holdings_percentage = holdings_percentage;
      else payload.amount = amount;
      return await ws(wallet_address, payload, 'order_created');
    }

    case 'place_twap_order': {
      const { wallet_address, token_address, action, frequency, duration, quantity, holdings_percentage, slippage = 500 } = args;
      if (!['twap_buy', 'twap_sell'].includes(action)) return { error: "action must be 'twap_buy' or 'twap_sell'" };
      if (action === 'twap_sell' && quantity == null && holdings_percentage == null) return { error: 'quantity or holdings_percentage required for twap_sell' };
      if (action === 'twap_buy' && quantity == null) return { error: 'quantity (SOL lamports) required for twap_buy' };
      if (!frequency || frequency < 1 || frequency > 100) return { error: 'frequency must be 1–100' };
      if (!duration || duration < 60) return { error: 'duration must be >= 60 seconds' };
      const payload = { action, token_address, frequency, duration, slippage };
      if (action === 'twap_sell') {
        if (quantity != null) payload.quantity = quantity;
        else payload.holdings_percentage = holdings_percentage;
      } else {
        payload.quantity = quantity;
      }
      return await ws(wallet_address, payload, 'twap_order_created');
    }

    case 'list_orders': {
      return await ws(args.wallet_address, { action: 'list_orders', wallet_address: args.wallet_address }, 'order_list');
    }

    case 'check_order': {
      return await ws(args.wallet_address, { action: 'check_order', order_id: args.order_id }, 'order_status');
    }

    case 'cancel_order': {
      return await ws(args.wallet_address, { action: 'cancel_order', order_id: args.order_id }, 'order_cancelled', 10000);
    }

    case 'extend_order': {
      if (args.expiry_hours < 1 || args.expiry_hours > 336) return { error: 'expiry_hours must be 1–336' };
      return await ws(args.wallet_address, { action: 'extend_order', order_id: args.order_id, expiry_hours: args.expiry_hours }, 'order_extended', 10000);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  // Pre-connect WS if private key is configured
  if (PRIVATE_KEY_B58) {
    try {
      const kp     = getKeypair();
      const wallet = kp.publicKey.toBase58();
      log('info', `Wallet: ${wallet}`);
      const mgr = getManager(wallet);
      // Don't block startup — let it connect in background
      mgr.waitRegistered(WS_STARTUP_WAIT_MS).then(ok => {
        if (ok) log('info', `WS registered for …${wallet.slice(-6)}`);
        else    log('warn', `WS did not register within ${WS_STARTUP_WAIT_MS / 1000}s; background reconnect continues`);
      });
    } catch (e) {
      log('warn', `Pre-connect skipped: ${e.message}`);
    }
  } else {
    log('warn', 'TRADEROUTER_PRIVATE_KEY not set — WS auth and auto-sign unavailable');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'traderouter MCP server running (stdio)');
}

main().catch(e => {
  log('error', e.message);
  process.exit(1);
});
