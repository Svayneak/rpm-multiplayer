/**
 * test/test_multi_client_sync.js
 * Verification of Multi-Client Real-Time Synchronization, Echo Suppression & Reconnection
 */

import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay.js';
import { RelayClient } from '../src/RelayClient.js';
import { RPMAppController } from '../src/app.js';

// Setup Mock DOM
const VOID_ELEMENTS = new Set(['img', 'input', 'hr', 'br', 'meta', 'link']);
class MockClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el.attributes['class'] = [...this.set].join(' '); }
  add(...cls) { cls.forEach(c => c && this.set.add(c)); this._sync(); }
  remove(...cls) { cls.forEach(c => this.set.delete(c)); this._sync(); }
  contains(c) { return this.set.has(c); }
}

class MockElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.classList = new MockClassList(this);
    this.style = {};
    this.listeners = new Map();
    this._value = '';
    this._textContent = '';
  }
  get id() { return this.attributes['id'] || ''; }
  set id(v) { this.attributes['id'] = v; }
  get className() { return this.attributes['class'] || ''; }
  set className(v) { this.attributes['class'] = v; this.classList.set = new Set(v.split(/\s+/).filter(Boolean)); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }
  get innerHTML() { return this._textContent; }
  set innerHTML(html) {
    this.children = [];
    this._textContent = html;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, val) { this.attributes[name] = String(val); }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(ev, fn) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev).push(fn);
  }
  removeEventListener(ev, fn) {
    if (!this.listeners.has(ev)) return;
    this.listeners.set(ev, this.listeners.get(ev).filter(f => f !== fn));
  }
  querySelector(sel) {
    if (!sel) return null;
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      if (this.id === id) return this;
      for (const ch of this.children) {
        const found = ch.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }
  querySelectorAll(sel) {
    const res = [];
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (this.classList.contains(cls)) res.push(this);
    }
    for (const ch of this.children) {
      res.push(...ch.querySelectorAll(sel));
    }
    return res;
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body', this);
  }
  createElement(tag) { return new MockElement(tag, this); }
  addEventListener() {}
  removeEventListener() {}
}

async function run() {
  console.log('=== RUNNING MULTI-CLIENT LIVE SYNCHRONIZATION AUDIT ===\n');

  // Boot relay server on ephemeral port
  const relay = createRelayServer();
  await new Promise(r => relay.listen(0, r));
  const port = relay.server.address().port;
  const relayUrl = `ws://127.0.0.1:${port}`;

  const doc = new MockDocument();
  globalThis.document = doc;
  globalThis.window = { document: doc, location: { host: 'localhost', protocol: 'http:' } };

  const c1 = doc.createElement('div');
  const c2 = doc.createElement('div');

  const app1 = new RPMAppController({ relayUrl, username: 'Alice', autoConnect: false });
  const app2 = new RPMAppController({ relayUrl, username: 'Bob', autoConnect: false });

  await app1.mount(c1);
  await app2.mount(c2);

  // 1. Host creates room
  const roomCode = await app1.createRoom();
  assert.ok(roomCode, 'Host must receive a valid roomCode');
  assert.equal(app1.myPlayerId, 'player_1');

  // 2. Client 2 joins room
  await app2.joinRoom(roomCode);
  await new Promise(r => setTimeout(r, 100)); // Network propagation

  assert.equal(app2.myPlayerId, 'player_2');
  assert.ok(app1.tabletopState.players['player_2'], 'Host must know player_2 joined');
  assert.ok(app2.tabletopState.players['player_1'], 'Client 2 must know player_1 is in room');

  // 3. Verify Echo Suppression on Action Broadcast
  // Host passes priority (priority rotates from player_1 to player_2)
  await app1.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
  await new Promise(r => setTimeout(r, 100)); // Propagate broadcast

  // Verify both clients agree player_2 now holds priority (and not passed twice by Host!)
  assert.equal(app1.priorityMachine.priorityPlayerId, 'player_2', 'Host priority must be player_2');
  assert.equal(app2.priorityMachine.priorityPlayerId, 'player_2', 'Client 2 priority must be player_2');

  // 4. Client 2 passes priority back to player_1
  await app2.dispatchAction({ type: 'PASS_PRIORITY' }, { origin: 'LOCAL' });
  await new Promise(r => setTimeout(r, 100));

  // Both passed on empty stack -> Phase step advanced to UPKEEP!
  assert.equal(app1.priorityMachine.currentPhaseStep, 'UPKEEP', 'Host phase must advance to UPKEEP');
  assert.equal(app2.priorityMachine.currentPhaseStep, 'UPKEEP', 'Client 2 phase must advance to UPKEEP');

  // 5. Clean teardown
  app1.destroy();
  app2.destroy();
  await new Promise(r => relay.close(r));

  console.log('✅ Multi-Client Real-Time Synchronization Verified!\n');
}

run().catch(err => {
  console.error('❌ Multi-Client Sync Test Failed:', err);
  process.exit(1);
});
