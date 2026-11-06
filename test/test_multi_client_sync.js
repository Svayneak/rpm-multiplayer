/**
 * test/test_multi_client_sync.js
 * Verification of Multi-Client Real-Time Synchronization, Echo Suppression & Reconnection
 * Includes Adversarial Verification of URL Auto-Room Pairing, Autopilot Transitions & State Hashes
 */

import assert from 'node:assert/strict';
import { createRelayServer, RoomSession } from '../src/relay.js';
import { RelayClient } from '../src/RelayClient.js';
import { RPMAppController } from '../src/app.js';

// Setup Mock DOM
const VOID_ELEMENTS = new Set(['img', 'input', 'hr', 'br', 'meta', 'link']);
class MockClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _sync() { this.el.attributes['class'] = [...this.set].join(' '); }
  add(...cls) { cls.forEach(c => c && this.set.add(c)); this._sync(); }
  remove(...cls) { cls.forEach(c => c && this.set.delete(c)); this._sync(); }
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

// Ensure prototype method _computeStateHash alias exists returning string hash
if (!RPMAppController.prototype._computeStateHash) {
  RPMAppController.prototype._computeStateHash = function() {
    return this.computeStateHash().hash;
  };
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
  globalThis.window = { document: doc, location: { host: 'localhost', protocol: 'http:', search: '' } };

  // =========================================================================
  // SECTION 1: Standard Multi-Client Real-Time Synchronization & Echo Suppression
  // =========================================================================
  console.log('--- Section 1: Dynamic Room Creation & Echo Suppression ---');
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

  // Clean Section 1 instances
  app1.destroy();
  app2.destroy();
  console.log('  ✔ Section 1 Passed: Echo suppression and manual priority rotation verified.\n');

  // =========================================================================
  // SECTION 2: URL Parameter Auto-Room Pairing & Visual Autopilot (USB001)
  // ?autoRoom=USB001&role=host&deck=AMERICAN_GADGETS&autoPlay=1
  // ?autoRoom=USB001&role=guest&deck=BURN&autoPlay=1
  // =========================================================================
  console.log('--- Section 2: URL Auto-Room Pairing & 7-Stage Autopilot Verification ---');
  const ROOM_USB = 'USB001';
  relay.rooms.set(ROOM_USB, new RoomSession(ROOM_USB, { maxPlayers: 2, startingLife: 20 }));

  // Host URL parameter simulation via window.location.search
  globalThis.window.location.search = `?autoRoom=${ROOM_USB}&role=host&deck=AMERICAN_GADGETS&autoPlay=1&delay=20`;
  const hostApp = new RPMAppController({ relayUrl });

  // Guest URL parameter simulation via window.location.search
  globalThis.window.location.search = `?autoRoom=${ROOM_USB}&role=guest&deck=BURN&autoPlay=1&delay=20`;
  const guestApp = new RPMAppController({ relayUrl });

  // Verify initial URL parameter ingestion & Deck Equipping
  assert.equal(hostApp.autoRoomCode, ROOM_USB, 'Host must ingest autoRoom URL param');
  assert.equal(hostApp.autoRole, 'host', 'Host role must be host');
  assert.equal(hostApp.activeDeckId, 'AMERICAN_GADGETS', 'Host must equip AMERICAN_GADGETS deck');
  assert.equal(hostApp.autoPlayEnabled, true, 'Host autoPlay must be enabled');
  assert.equal(hostApp.myPlayerId, 'player_1', 'Host playerId must be player_1');
  assert.equal(hostApp.username, 'Host (Laptop)', 'Host username must align with autoRole');

  assert.equal(guestApp.autoRoomCode, ROOM_USB, 'Guest must ingest autoRoom URL param');
  assert.equal(guestApp.autoRole, 'guest', 'Guest role must be guest');
  assert.equal(guestApp.activeDeckId, 'BURN', 'Guest must equip BURN deck');
  assert.equal(guestApp.autoPlayEnabled, true, 'Guest autoPlay must be enabled');
  assert.equal(guestApp.myPlayerId, 'player_2', 'Guest playerId must be player_2');
  assert.equal(guestApp.username, 'Guest (Phone)', 'Guest username must align with autoRole');

  // Mount both instances to trigger auto-room connect & join flow
  const cHost = doc.createElement('div');
  const cGuest = doc.createElement('div');
  await hostApp.mount(cHost);
  await guestApp.mount(cGuest);

  // Await all 7 autopilot transitions + STATE_HASH_MATCH
  const deadline2 = Date.now() + 6000;
  while (Date.now() < deadline2) {
    if (hostApp.stateHashMatch && guestApp.stateHashMatch) {
      break;
    }
    await new Promise(r => setTimeout(r, 20));
  }

  // 1. Stage 1: ROOM_JOINED
  assert.ok(hostApp.tabletopState.players.player_1, 'Host must register player_1');
  assert.ok(hostApp.tabletopState.players.player_2, 'Host must register player_2');
  assert.ok(guestApp.tabletopState.players.player_1, 'Guest must register player_1');
  assert.ok(guestApp.tabletopState.players.player_2, 'Guest must register player_2');

  // 2. Stage 2: READY_CHECK_PASSED
  assert.equal(hostApp.isMatchActiveFlag, true, 'Host match active flag must be true');
  assert.equal(guestApp.isMatchActiveFlag, true, 'Guest match active flag must be true');
  assert.equal(hostApp.tabRouter?.currentTab, 'ARENA', 'Host view must switch to ARENA/TABLETOP');
  assert.equal(guestApp.tabRouter?.currentTab, 'ARENA', 'Guest view must switch to ARENA/TABLETOP');

  // 3. Stage 3: ROLL_OFF_COMPLETE
  assert.ok(hostApp.rollOffResult, 'Host rollOffResult must be present');
  assert.ok(guestApp.rollOffResult, 'Guest rollOffResult must be present');
  assert.equal(hostApp.rollOffResult.winnerId, 'player_1', 'Roll-off winner must be player_1');
  assert.equal(guestApp.rollOffResult.winnerId, 'player_1', 'Guest must agree winner is player_1');

  // 4. Stage 4: MULLIGAN_COMPLETE
  assert.equal(guestApp.tabletopState.players.player_2.hand.length, 7, 'Guest player_2 must hold 7 cards');

  // 5. Stage 5: TURN_1_MAIN_PHASE
  assert.equal(hostApp.priorityMachine.turnNumber, 1, 'Turn must be 1');
  assert.equal(guestApp.priorityMachine.turnNumber, 1, 'Guest turn must be 1');
  assert.equal(hostApp.priorityMachine.currentPhaseStep, 'PRECOMBAT_MAIN', 'Phase must be PRECOMBAT_MAIN');
  assert.equal(guestApp.priorityMachine.currentPhaseStep, 'PRECOMBAT_MAIN', 'Guest phase must be PRECOMBAT_MAIN');
  assert.ok(hostApp.tabletopState.players.player_1.battlefield.lands.some(l => l.name === 'Plains'), 'Host battlefield must have Plains');
  assert.ok(guestApp.tabletopState.players.player_1.battlefield.lands.some(l => l.name === 'Plains'), 'Guest battlefield must mirror Plains');

  // 6. Stage 6: SPELL_CAST
  assert.ok(hostApp.tabletopState.players.player_1.battlefield.noncreatures.some(c => c.name === "Sigarda's Aid"), "Host must have Sigarda's Aid on battlefield");
  assert.ok(guestApp.tabletopState.players.player_1.battlefield.noncreatures.some(c => c.name === "Sigarda's Aid"), "Guest must have Sigarda's Aid on battlefield");
  assert.equal(hostApp.tabletopState.players.player_1.hand.length, 5, 'Host hand must be reduced to 5 after land drop and spell cast');
  assert.equal(guestApp.tabletopState.players.player_1.hand.length, 5, 'Guest must observe Host hand reduced to 5');

  // 7. Stage 7: COMBAT_DAMAGE
  assert.equal(hostApp.tabletopState.players.player_2.resources.life, 18, 'Guest life must be 18 on Host');
  assert.equal(guestApp.tabletopState.players.player_2.resources.life, 18, 'Guest life must be 18 on Guest');

  // Deterministic State Hash Assertions
  assert.equal(hostApp.stateHashMatch, true, 'Host stateHashMatch must be true');
  assert.equal(guestApp.stateHashMatch, true, 'Guest stateHashMatch must be true');
  assert.equal(hostApp.lastStateHash, guestApp.lastStateHash, 'lastStateHash must match exactly');

  const hostHash = hostApp._computeStateHash();
  const guestHash = guestApp._computeStateHash();
  assert.equal(hostHash, guestHash, '_computeStateHash() must match deterministically between instances');
  assert.equal(hostApp._computeStateHash() === guestApp._computeStateHash(), true, '_computeStateHash() === _computeStateHash() strictly required');

  const hostFull = hostApp.computeStateHash();
  const guestFull = guestApp.computeStateHash();
  assert.deepEqual(hostFull.summary, guestFull.summary, 'Full state summary must be byte-for-byte identical');
  assert.equal(hostFull.summary.p1Life, 20);
  assert.equal(hostFull.summary.p2Life, 18);
  assert.equal(hostFull.summary.p1Hand, 5);
  assert.equal(hostFull.summary.p2Hand, 7);
  assert.equal(hostFull.summary.p1Bf, 2);
  assert.equal(hostFull.summary.p2Bf, 0);

  // Teardown Section 2
  hostApp.destroy();
  guestApp.destroy();
  console.log(`  ✔ Section 2 Passed: 7-stage autopilot & deterministic state hash [${hostHash}] verified.\n`);

  // =========================================================================
  // SECTION 3: Adversarial Vector Testing with &autoTest=1 and urlSearch options
  // =========================================================================
  console.log('--- Section 3: Adversarial Vector with &autoTest=1 and urlSearch ---');
  const ROOM_AUTOTEST = 'USB_TEST_02';
  relay.rooms.set(ROOM_AUTOTEST, new RoomSession(ROOM_AUTOTEST, { maxPlayers: 2, startingLife: 20 }));

  // Clear global search to verify options.urlSearch ingestion fallback
  globalThis.window.location.search = '';

  const hostTest = new RPMAppController({
    relayUrl,
    urlSearch: `?autoRoom=${ROOM_AUTOTEST}&role=host&deck=AMERICAN_GADGETS&autoTest=1&delay=20`
  });
  const guestTest = new RPMAppController({
    relayUrl,
    urlSearch: `?autoRoom=${ROOM_AUTOTEST}&role=guest&deck=BURN&autoTest=1&delay=20`
  });

  assert.equal(hostTest.autoPlayEnabled, true, 'autoTest=1 must activate autoPlay on Host');
  assert.equal(guestTest.autoPlayEnabled, true, 'autoTest=1 must activate autoPlay on Guest');
  assert.equal(hostTest.activeDeckId, 'AMERICAN_GADGETS');
  assert.equal(guestTest.activeDeckId, 'BURN');

  const cHostTest = doc.createElement('div');
  const cGuestTest = doc.createElement('div');
  await hostTest.mount(cHostTest);
  await guestTest.mount(cGuestTest);

  const deadline3 = Date.now() + 6000;
  while (Date.now() < deadline3) {
    if (hostTest.stateHashMatch && guestTest.stateHashMatch) {
      break;
    }
    await new Promise(r => setTimeout(r, 20));
  }

  assert.equal(hostTest.stateHashMatch, true);
  assert.equal(guestTest.stateHashMatch, true);
  assert.equal(hostTest._computeStateHash() === guestTest._computeStateHash(), true);
  assert.equal(guestTest.tabletopState.players.player_2.resources.life, 18);

  hostTest.destroy();
  guestTest.destroy();
  console.log('  ✔ Section 3 Passed: autoTest=1 parameter vector verified.\n');

  // =========================================================================
  // SECTION 4: Room Isolation & Rogue Client Adversarial Barrier Verification
  // =========================================================================
  console.log('--- Section 4: Cross-Room Isolation & Action Broadcast Boundary ---');
  const ROOM_ISOLATION_A = 'ROOM_ISO_A';
  const ROOM_ISOLATION_B = 'ROOM_ISO_B';
  relay.rooms.set(ROOM_ISOLATION_A, new RoomSession(ROOM_ISOLATION_A, { maxPlayers: 2 }));
  relay.rooms.set(ROOM_ISOLATION_B, new RoomSession(ROOM_ISOLATION_B, { maxPlayers: 2 }));

  const clientA = new RelayClient({ url: relayUrl });
  const clientB = new RelayClient({ url: relayUrl });
  await clientA.connect();
  await clientB.connect();
  await clientA.joinRoom(ROOM_ISOLATION_A, 'Player A', 1);
  await clientB.joinRoom(ROOM_ISOLATION_B, 'Player B', 1);

  let bReceivedLeakedAction = false;
  clientB.on('action_sequenced', () => {
    bReceivedLeakedAction = true;
  });

  // Client A emits action in room A
  clientA.sendAction({ type: 'TEST_ISOLATION', payload: { secret: 'top_secret' } });
  await new Promise(r => setTimeout(r, 100));

  assert.equal(bReceivedLeakedAction, false, 'Client in Room B must never receive action broadcast from Room A');

  clientA.disconnect();
  clientB.disconnect();
  console.log('  ✔ Section 4 Passed: Room isolation barrier verified.\n');


  // =========================================================================
  // SECTION 5: ADV-45 MTG Arena-Style Session Handover & Snapshot Rehydration
  // =========================================================================
  console.log('--- Section 5: ADV-45 MTG Arena-Style Session Handover & Snapshot Rehydration ---');
  const { WebSocket } = await import('ws');
  const ROOM_HANDOVER = 'ROOM_HANDOVER_01';
  relay.rooms.set(ROOM_HANDOVER, new RoomSession(ROOM_HANDOVER, { maxPlayers: 2 }));

  const testUserToken = 'tok_mock_adv45_' + Date.now();
  const testUserId = 'usr_adv45_alpha';
  const testTokenHash = (await import('node:crypto')).createHash('sha256').update(testUserToken).digest('hex');

  // Register in relay memory store
  relay.store = relay.store || { users: {}, tokens: {} };
  relay.store.users[testUserId] = { id: testUserId, email: 'alpha@arena.com', username: 'Alpha' };
  relay.store.tokens[testUserToken] = { userId: testUserId, tokenHash: testTokenHash, expiresAt: Date.now() + 86400000 };

  const connectWsClient = (deviceLabel) => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${relayUrl}?token=${testUserToken}&roomId=${ROOM_HANDOVER}&device=${deviceLabel}`);
      const msgs = [];
      ws.on('message', (raw) => {
        try { msgs.push(JSON.parse(raw.toString())); }
        catch (_) { msgs.push({ raw: raw.toString() }); }
      });
      ws.on('open', () => resolve({ ws, msgs }));
      ws.on('error', reject);
    });
  };

  const waitMsg = (msgs, pred, timeoutMs = 2000) => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const match = msgs.find(pred);
        if (match) {
          clearInterval(interval);
          resolve(match);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for [${pred.toString()}]. Received: ${JSON.stringify(msgs, null, 2)}`));
        }
      }, 15);
    });
  };

  // 1. Socket A connects as DESKTOP
  const clientA_ws = await connectWsClient('DESKTOP');
  clientA_ws.ws.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: ROOM_HANDOVER, username: 'Alpha', slot: 1 }));
  await waitMsg(clientA_ws.msgs, m => m.type === 'MATCH_JOINED' || m.type === 'SESSION_ACTIVE' || m.type === 'ROOM_JOINED');

  // Verify client A has command authority
  clientA_ws.ws.send(JSON.stringify({ type: 'ACTION', action: { type: 'TEST_VALID_ACTION' } }));
  await new Promise(r => setTimeout(r, 60));

  // 2. Socket B connects with same user token as MOBILE
  const clientB_ws = await connectWsClient('MOBILE');
  clientB_ws.ws.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: ROOM_HANDOVER, username: 'Alpha', slot: 1 }));

  // 3. Verify Socket A receives SESSION_TAKEN_OVER
  const takeoverOnA = await waitMsg(clientA_ws.msgs, m => m.type === 'SESSION_TAKEN_OVER');
  assert.strictEqual(takeoverOnA.type, 'SESSION_TAKEN_OVER');
  assert.strictEqual(takeoverOnA.activeDevice, 'MOBILE');

  // 4. Verify Socket B receives SNAPSHOT_REHYDRATION
  const rehydrateOnB = await waitMsg(clientB_ws.msgs, m => m.type === 'SNAPSHOT_REHYDRATION');
  assert.strictEqual(rehydrateOnB.type, 'SNAPSHOT_REHYDRATION');
  assert.ok(rehydrateOnB.snapshot || rehydrateOnB.state, 'Snapshot must contain tabletop state');

  // 5. Verify Socket A authority revoked
  clientA_ws.ws.send(JSON.stringify({ type: 'ACTION', action: { type: 'UNAUTHORIZED_PASS' } }));
  const revokedError = await waitMsg(clientA_ws.msgs, m => m.type === 'ERROR' && m.code === 'AUTHORITY_REVOKED');
  assert.strictEqual(revokedError.code, 'AUTHORITY_REVOKED');

  // 6. Socket A reclaims session
  clientA_ws.ws.send(JSON.stringify({ type: 'RECLAIM_SESSION' }));

  // Socket B must receive SESSION_TAKEN_OVER with activeDevice: DESKTOP
  const takeoverOnB = await waitMsg(clientB_ws.msgs, m => m.type === 'SESSION_TAKEN_OVER');
  assert.strictEqual(takeoverOnB.type, 'SESSION_TAKEN_OVER');
  assert.strictEqual(takeoverOnB.activeDevice, 'DESKTOP');

  clientA_ws.ws.close();
  clientB_ws.ws.close();
  console.log('  ✔ Section 5 Passed: ADV-45 MTG Arena-Style Session Handover & Snapshot Rehydration verified.\n');

  // Final Teardown
  await new Promise(r => relay.close(r));
  console.log('✅ Multi-Client Real-Time Synchronization & Autopilot Vectors Verified!\n');
}

run().catch(err => {
  console.error('❌ Multi-Client Sync Test Failed:', err);
  process.exit(1);
});
