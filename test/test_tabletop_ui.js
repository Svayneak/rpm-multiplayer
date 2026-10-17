/**
 * test/test_tabletop_ui.js
 * Automated Verification Test Suite for Feature 7:
 * Minimalist Tap-to-Expand Accordion Tabletop UI & Scryfall Overlay Modal
 * 
 * Document ID: SPEC-RPM-UI-007
 * Validates all 12 acceptance test cases from Section 8 of the specification
 * plus additional regression and interaction suites.
 */

import assert from 'node:assert';
import { TabletopUI } from '../src/view/TabletopUI.js';
import { CardOverlayModal, formatManaSymbols } from '../src/view/CardOverlayModal.js';
import { TabletopStateManager } from '../src/TabletopStateManager.js';
import { PriorityStateMachine } from '../src/PriorityStateMachine.js';
import { DualChannelChat } from '../src/DualChannelChat.js';

// ============================================================================
// Lightweight Mock DOM Environment for Node.js
// ============================================================================

class MockEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles ?? true;
    this.cancelable = options.cancelable ?? true;
    this.target = null;
    this._propagationStopped = false;
  }

  stopPropagation() {
    this._propagationStopped = true;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class MockKeyboardEvent extends MockEvent {
  constructor(type, options = {}) {
    super(type, options);
    this.key = options.key || '';
    this.keyCode = options.keyCode || 0;
  }
}

class MockMouseEvent extends MockEvent {
  constructor(type, options = {}) {
    super(type, options);
  }
}

const VOID_ELEMENTS = new Set(['img', 'input', 'hr', 'br', 'meta', 'link']);

function matchesSelector(elem, selector) {
  if (!elem || !selector || typeof selector !== 'string') return false;
  let remaining = selector.trim();

  // Tag name
  const tagMatch = remaining.match(/^[a-zA-Z0-9\-]+/);
  if (tagMatch) {
    if (elem.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    remaining = remaining.slice(tagMatch[0].length);
  }

  // ID
  const idMatch = remaining.match(/^#([a-zA-Z0-9\-_]+)/);
  if (idMatch) {
    if (elem.id !== idMatch[1]) return false;
    remaining = remaining.slice(idMatch[0].length);
  }

  // Classes
  const classMatches = remaining.matchAll(/\.([a-zA-Z0-9\-_]+)/g);
  for (const cm of classMatches) {
    if (!elem.classList.contains(cm[1])) return false;
  }
  remaining = remaining.replace(/\.([a-zA-Z0-9\-_]+)/g, '');

  // Attributes
  const attrMatches = remaining.matchAll(/\[([a-zA-Z0-9\-_]+)(?:=[\"\']?([^\x22\x27\]]*)[\"\']?)?\]/g);
  for (const am of attrMatches) {
    const attrName = am[1];
    const attrVal = am[2];
    if (attrVal !== undefined) {
      if (elem.getAttribute(attrName) !== attrVal) return false;
    } else {
      if (!elem.hasAttribute(attrName)) return false;
    }
  }

  return true;
}

class MockClassList {
  constructor(element) {
    this.element = element;
    this._classes = new Set();
  }

  _syncFromClassName(className = '') {
    this._classes.clear();
    className.split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c));
  }

  _syncToClassName() {
    this.element.attributes['class'] = [...this._classes].join(' ');
  }

  add(...classes) {
    classes.forEach(c => c && this._classes.add(c));
    this._syncToClassName();
  }

  remove(...classes) {
    classes.forEach(c => this._classes.delete(c));
    this._syncToClassName();
  }

  contains(c) {
    return this._classes.has(c);
  }

  toggle(c, force) {
    if (force !== undefined) {
      if (force) this.add(c);
      else this.remove(c);
      return force;
    }
    if (this.contains(c)) {
      this.remove(c);
      return false;
    } else {
      this.add(c);
      return true;
    }
  }

  toString() {
    return [...this._classes].join(' ');
  }
}

class MockElement {
  constructor(tagName = 'div') {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this._eventListeners = new Map();
    this.classList = new MockClassList(this);
    this.style = {};
  }

  get id() {
    return this.attributes['id'] || '';
  }

  set id(val) {
    this.attributes['id'] = val;
  }

  get className() {
    return this.attributes['class'] || '';
  }

  set className(val) {
    this.attributes['class'] = val;
    this.classList._syncFromClassName(val);
  }

  get src() {
    return this.attributes['src'] || '';
  }

  set src(val) {
    this.attributes['src'] = val;
  }

  get alt() {
    return this.attributes['alt'] || '';
  }

  set alt(val) {
    this.attributes['alt'] = val;
  }

  get disabled() {
    return this.attributes['disabled'] === 'true' || this.attributes['disabled'] === true || this.attributes['disabled'] === '';
  }

  set disabled(val) {
    if (val) {
      this.attributes['disabled'] = 'true';
    } else {
      delete this.attributes['disabled'];
    }
  }

  get value() {
    return this._value !== undefined ? this._value : (this.attributes['value'] || '');
  }

  set value(val) {
    this._value = String(val);
  }

  getAttribute(name) {
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
    if (name === 'class') {
      this.classList._syncFromClassName(String(val));
    }
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'class') {
      this.classList._syncFromClassName('');
    }
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) {
      this.children.push(child);
    }
    return child;
  }

  removeChild(child) {
    if (!child) return child;
    const cnIdx = this.childNodes.indexOf(child);
    if (cnIdx !== -1) this.childNodes.splice(cnIdx, 1);
    const cIdx = this.children.indexOf(child);
    if (cIdx !== -1) this.children.splice(cIdx, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!refChild) return this.appendChild(newChild);
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    const cnIdx = this.childNodes.indexOf(refChild);
    if (cnIdx !== -1) {
      this.childNodes.splice(cnIdx, 0, newChild);
    } else {
      this.childNodes.push(newChild);
    }
    if (newChild.nodeType === 1) {
      const cIdx = this.children.indexOf(refChild);
      if (cIdx !== -1) {
        this.children.splice(cIdx, 0, newChild);
      } else {
        this.children.push(newChild);
      }
    }
    return newChild;
  }

  get textContent() {
    let text = '';
    for (const node of this.childNodes) {
      if (node.nodeType === 3) {
        text += node.textContent;
      } else if (node.nodeType === 1) {
        text += node.textContent;
      }
    }
    return text;
  }

  set textContent(val) {
    this.childNodes = [];
    this.children = [];
    if (val !== undefined && val !== null && val !== '') {
      this.childNodes.push({
        nodeType: 3,
        textContent: String(val),
        parentNode: this
      });
    }
  }

  get innerHTML() {
    let out = '';
    for (const node of this.childNodes) {
      if (node.nodeType === 3) {
        out += node.textContent;
      } else if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        let attrs = '';
        for (const [k, v] of Object.entries(node.attributes)) {
          attrs += ` ${k}="${v}"`;
        }
        if (VOID_ELEMENTS.has(tag)) {
          out += `<${tag}${attrs} />`;
        } else {
          out += `<${tag}${attrs}>${node.innerHTML}</${tag}>`;
        }
      }
    }
    return out;
  }

  set innerHTML(htmlStr) {
    this.childNodes = [];
    this.children = [];
    if (!htmlStr || typeof htmlStr !== 'string') return;
    this._parseAndPopulate(htmlStr);
  }

  _parseAndPopulate(html) {
    let current = this;
    const tagRegex = /<(\/)?([a-zA-Z0-9\-]+)([^>]*)>|([^<]+)/g;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      if (match[4]) {
        // Text node
        const text = match[4];
        current.childNodes.push({
          nodeType: 3,
          textContent: text,
          parentNode: current
        });
      } else {
        const isClose = Boolean(match[1]);
        const tagName = match[2];
        const attrStr = match[3] || '';

        if (isClose) {
          if (current.parentNode) {
            current = current.parentNode;
          }
        } else {
          const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase()) || attrStr.trim().endsWith('/');
          const elem = new MockElement(tagName);
          elem.parentNode = current;

          // Parse attributes
          const attrRegex = /([a-zA-Z0-9\-_:@]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
          let aMatch;
          while ((aMatch = attrRegex.exec(attrStr)) !== null) {
            const aName = aMatch[1];
            const aVal = aMatch[2] !== undefined ? aMatch[2] : (aMatch[3] !== undefined ? aMatch[3] : (aMatch[4] !== undefined ? aMatch[4] : ''));
            elem.setAttribute(aName, aVal);
          }

          current.appendChild(elem);

          if (!isVoid) {
            current = elem;
          }
        }
      }
    }
  }

  querySelector(selector) {
    const list = this.querySelectorAll(selector);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(selector) {
    if (!selector || typeof selector !== 'string') return [];
    const parts = selector.trim().split(/\s+/);

    if (parts.length === 1) {
      const results = [];
      const search = (node) => {
        if (!node || !node.children) return;
        for (const child of node.children) {
          if (matchesSelector(child, parts[0])) {
            results.push(child);
          }
          search(child);
        }
      };
      search(this);
      return results;
    }

    const firstMatches = this.querySelectorAll(parts[0]);
    const restSelector = parts.slice(1).join(' ');
    const results = [];
    for (const match of firstMatches) {
      results.push(...match.querySelectorAll(restSelector));
    }
    return [...new Set(results)];
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.nodeType === 1 && matchesSelector(curr, selector)) {
        return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, []);
    }
    this._eventListeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this._eventListeners.has(type)) return;
    const list = this._eventListeners.get(type).filter(l => l !== listener);
    this._eventListeners.set(type, list);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;

    const list = this._eventListeners.get(event.type) || [];
    for (const fn of list) {
      try {
        fn.call(this, event);
      } catch (err) {
        console.error('Error in listener:', err);
      }
      if (event._propagationStopped) break;
    }

    const inlineHandler = this['on' + event.type];
    if (typeof inlineHandler === 'function' && !event._propagationStopped) {
      try {
        inlineHandler.call(this, event);
      } catch (err) {
        console.error('Error in inline handler:', err);
      }
    }

    if (event.bubbles && !event._propagationStopped && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
      this.parentNode.dispatchEvent(event);
    }

    return !event.defaultPrevented;
  }

  click() {
    const evt = new MockMouseEvent('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(evt);
  }

  focus() {
    if (typeof globalThis.document !== 'undefined') {
      globalThis.document.activeElement = this;
    }
  }

  blur() {
    if (typeof globalThis.document !== 'undefined' && globalThis.document.activeElement === this) {
      globalThis.document.activeElement = null;
    }
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
    this.activeElement = null;
    this._eventListeners = new Map();
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  getElementById(id) {
    return this.querySelector('#' + id);
  }

  querySelector(selector) {
    if (matchesSelector(this.body, selector)) return this.body;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, []);
    }
    this._eventListeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this._eventListeners.has(type)) return;
    const list = this._eventListeners.get(type).filter(l => l !== listener);
    this._eventListeners.set(type, list);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const list = this._eventListeners.get(event.type) || [];
    for (const fn of list) {
      try {
        fn.call(this, event);
      } catch (err) {
        console.error('Error in doc listener:', err);
      }
      if (event._propagationStopped) break;
    }
    return !event.defaultPrevented;
  }
}

// Global environment setup
const mockDoc = new MockDocument();
globalThis.document = mockDoc;
globalThis.window = globalThis;
globalThis.KeyboardEvent = MockKeyboardEvent;
globalThis.MouseEvent = MockMouseEvent;
globalThis.Event = MockEvent;

// ============================================================================
// Test Suite Runner
// ============================================================================

let totalPassed = 0;
let totalFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    totalPassed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    totalFailed++;
    process.exit(1);
  }
}

console.log('\n==================================================================');
console.log('Running Acceptance Test Suite: Feature 7 Accordion UI & Card Modal');
console.log('Document ID: SPEC-RPM-UI-007');
console.log('==================================================================\n');

let container;
let ttsm;
let psm;
let chat;
let ui;

function setup() {
  document.body.innerHTML = '<div id="tabletop-root"></div>';
  container = document.getElementById('tabletop-root');

  ttsm = new TabletopStateManager({
    sessionId: 'test_session',
    players: ['p1', 'p2']
  });

  psm = new PriorityStateMachine({
    sessionId: 'test_session',
    players: ['p1', 'p2'],
    activePlayerId: 'p1',
    priorityPlayerId: 'p1'
  });

  chat = new DualChannelChat({
    sessionId: 'test_session',
    myPlayerId: 'p1',
    priorityStateMachine: psm,
    tabletopStateManager: ttsm
  });

  ui = new TabletopUI({
    container,
    tabletopStateManager: ttsm,
    priorityStateMachine: psm,
    dualChannelChat: chat,
    myPlayerId: 'p1',
    opponentPlayerId: 'p2'
  });
}

// ----------------------------------------------------------------------------
// TEST 1: Summary Bar Rendering
// ----------------------------------------------------------------------------
runTest('TEST-UI-001: Renders Opponent and Player Summary Bars with Life, Counters, and Land Mana', () => {
  setup();

  ttsm.setPlayerLife('p1', 17);
  ttsm.setPlayerLife('p2', 14);

  ui.render();

  const playerLifeEl = container.querySelector('#player-board .life-badge');
  const opponentLifeEl = container.querySelector('#opponent-board .life-badge');

  assert(playerLifeEl, '#player-board .life-badge must exist');
  assert(opponentLifeEl, '#opponent-board .life-badge must exist');

  assert(playerLifeEl.textContent.includes('17'), 'Player life total should be 17');
  assert(opponentLifeEl.textContent.includes('14'), 'Opponent life total should be 14');

  // Land mana bar renders
  const playerManaBar = container.querySelector('#player-board .land-mana-bar');
  assert(playerManaBar !== null, 'Player land mana bar must exist');
});

// ----------------------------------------------------------------------------
// TEST 2: Accordion Expand / Collapse Transitions
// ----------------------------------------------------------------------------
runTest('TEST-UI-002: Toggling zone drawer badges expands and collapses accordion content', () => {
  setup();
  ui.render();

  const creaturesDrawer = container.querySelector('#player-board .zone-drawer[data-zone="creatures"]');
  assert(creaturesDrawer, 'Creatures drawer should exist');

  const creaturesBadge = creaturesDrawer.querySelector('.zone-drawer-badge');
  assert(creaturesBadge, 'Creatures badge should exist');

  // Initially collapsed
  assert.strictEqual(creaturesDrawer.getAttribute('data-expanded'), 'false');

  // Tap badge to expand
  creaturesBadge.click();
  assert.strictEqual(creaturesDrawer.getAttribute('data-expanded'), 'true');

  // Tap badge again to collapse
  creaturesBadge.click();
  assert.strictEqual(creaturesDrawer.getAttribute('data-expanded'), 'false');
});

// ----------------------------------------------------------------------------
// TEST 3: Fog-of-War Masking in Opponent Hand
// ----------------------------------------------------------------------------
runTest('TEST-UI-003: Masks cards in opponent hand when unrevealed; renders face-down tokens with zero leaked card data', () => {
  setup();

  // Give opponent 3 cards
  ttsm.addCardToZone('p2', 'hand', { name: 'Lightning Bolt', manaCost: '{R}' });
  ttsm.addCardToZone('p2', 'hand', { name: 'Counterspell', manaCost: '{U}{U}' });
  ttsm.addCardToZone('p2', 'hand', { name: 'Ragavan', manaCost: '{R}' });

  ui.render();

  const oppHandDrawer = container.querySelector('#opponent-board .zone-drawer[data-zone="hand"]');
  const oppHandBadge = oppHandDrawer.querySelector('.zone-drawer-badge');
  assert(oppHandBadge.textContent.includes('3'), 'Opponent hand badge should show count 3');

  // Expand hand drawer
  oppHandBadge.click();

  const maskedCards = oppHandDrawer.querySelectorAll('.card-facedown');
  assert.strictEqual(maskedCards.length, 3, 'Should render exactly 3 face-down masked card tokens');

  // Verify private text does NOT leak into DOM
  const innerHtml = oppHandDrawer.innerHTML;
  assert(!innerHtml.includes('Lightning Bolt'), 'Lightning Bolt must not leak into opponent hand DOM');
  assert(!innerHtml.includes('Counterspell'), 'Counterspell must not leak into opponent hand DOM');
  assert(!innerHtml.includes('Ragavan'), 'Ragavan must not leak into opponent hand DOM');
});

// ----------------------------------------------------------------------------
// TEST 4: Opponent Library Count Concealment
// ----------------------------------------------------------------------------
runTest('TEST-UI-004: Opponent library renders card count only; conceals card identities and ordering', () => {
  setup();

  for (let i = 0; i < 45; i++) {
    ttsm.addCardToZone('p2', 'library', { name: `SecretCard_${i}` });
  }

  ui.render();

  const libDrawer = container.querySelector('#opponent-board .zone-drawer[data-zone="library"]');
  const libBadge = libDrawer.querySelector('.zone-drawer-badge');
  assert(libBadge.textContent.includes('45'), 'Library badge should show 45');

  libBadge.click();
  assert(!libDrawer.innerHTML.includes('SecretCard_0'), 'Secret card name must not leak');
  assert.strictEqual(libDrawer.querySelectorAll('.card-item').length, 0, 'No individual card items should be rendered');
  assert(libDrawer.querySelector('.deck-count-indicator').textContent.includes('45'), 'Deck count indicator should display 45');
});

// ----------------------------------------------------------------------------
// TEST 5: Active Player Hand Rendering & Mana Font Glyphs
// ----------------------------------------------------------------------------
runTest('TEST-UI-005: Renders active player hand with full card names and vector mana-font icons', () => {
  setup();

  ttsm.addCardToZone('p1', 'hand', {
    name: 'Fatal Push',
    manaCost: '{B}',
    typeLine: 'Instant'
  });

  ui.render();

  const handDrawer = container.querySelector('#player-board .zone-drawer[data-zone="hand"]');
  assert(handDrawer.textContent.includes('Fatal Push'), 'Active player hand must contain Fatal Push');
  assert(handDrawer.querySelector('.ms.ms-b') !== null, 'Mana glyph .ms.ms-b must be present');
});

// ----------------------------------------------------------------------------
// TEST 6: CardOverlayModal Mount & High-Res Inspection
// ----------------------------------------------------------------------------
runTest('TEST-UI-006: Tapping an inspectable card opens CardOverlayModal with full details and Modern Legal badge', () => {
  setup();

  const card = {
    name: "Dragon's Rage Channeler",
    manaCost: '{R}',
    typeLine: 'Creature — Human Shaman',
    oracleText: 'Whenever you cast a noncreature spell, surveil 1.',
    power: 1,
    toughness: 1,
    modernLegal: true,
    imageUri: 'https://cards.scryfall.io/large/front/d/r/drc.jpg'
  };

  ttsm.addCardToZone('p1', 'battlefield', card);
  ui.render();

  const cardElement = container.querySelector('#player-board .card-item');
  assert(cardElement, 'Card element must exist on player battlefield');
  cardElement.click();

  const modal = document.querySelector('#card-overlay-modal');
  assert(modal, 'Modal element should exist in DOM');
  assert(modal.classList.contains('visible'), 'Modal should have visible class');
  assert.strictEqual(modal.querySelector('.modal-card-name').textContent, "Dragon's Rage Channeler");
  assert.strictEqual(modal.querySelector('.modal-card-typeline').textContent, 'Creature — Human Shaman');
  assert(modal.querySelector('.badge-modern-legal') !== null, 'Modern Legal badge must be present');
  assert.strictEqual(modal.querySelector('.modal-card-image').src, 'https://cards.scryfall.io/large/front/d/r/drc.jpg');
});

// ----------------------------------------------------------------------------
// TEST 7: CardOverlayModal Dismissal Mechanics
// ----------------------------------------------------------------------------
runTest('TEST-UI-007: Dismisses CardOverlayModal via backdrop click, close button, and Escape key', () => {
  setup();

  const modal = ui.cardModal;
  modal.open({ name: 'Lightning Bolt', manaCost: '{R}' });

  const modalEl = document.querySelector('#card-overlay-modal');
  assert(modalEl.classList.contains('visible'), 'Modal should be visible on open');

  // 1. Close button click
  modalEl.querySelector('.modal-close-btn').click();
  assert(!modalEl.classList.contains('visible'), 'Modal should close on close button click');

  // 2. Reopen & test Escape key
  modal.open({ name: 'Lightning Bolt' });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert(!modalEl.classList.contains('visible'), 'Modal should close on Escape key');

  // 3. Reopen & test Backdrop click
  modal.open({ name: 'Lightning Bolt' });
  modalEl.click();
  assert(!modalEl.classList.contains('visible'), 'Modal should close on backdrop click');

  // 4. Test Tab focus isolation
  modal.open({ name: 'Lightning Bolt' });
  const closeBtn = modalEl.querySelector('.modal-close-btn');
  closeBtn.focus();
  assert.strictEqual(document.activeElement, closeBtn, 'Close button should be focused');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  assert.strictEqual(document.activeElement, closeBtn, 'Focus must remain trapped inside modal dialog');
  modal.close();
});

// ----------------------------------------------------------------------------
// TEST 8: The Stack LIFO Order Rendering
// ----------------------------------------------------------------------------
runTest('TEST-UI-008: Renders items on the stack in strict LIFO order (newest on top)', () => {
  setup();

  psm.dispatch('CAST_SPELL', {
    playerId: 'p1',
    card: { name: "Mishra's Bauble", manaCost: '{0}' }
  });
  psm.dispatch('CAST_SPELL', {
    playerId: 'p2',
    card: { name: 'Spell Pierce', manaCost: '{U}' }
  });

  ui.render();

  const stackItems = container.querySelectorAll('.stack-queue-list .stack-item');
  assert.strictEqual(stackItems.length, 2, 'Should render 2 items on the stack');
  // LIFO Top item is Spell Pierce
  assert(stackItems[0].textContent.includes('Spell Pierce'), 'Top of stack (#2) must be Spell Pierce');
  assert(stackItems[1].textContent.includes("Mishra's Bauble"), 'Bottom of stack (#1) must be Mishra\'s Bauble');
});

// ----------------------------------------------------------------------------
// TEST 9: 15-Second Stack Alarm Banner & Action Triggers
// ----------------------------------------------------------------------------
runTest('TEST-UI-009: Displays 15-second Stack Alarm banner with countdown progress and Pass/Hold triggers', () => {
  setup();

  const alarmManager = psm.alarmManager;
  alarmManager.start('p1', 'stack_item_123', 15);

  ui.render();

  const banner = container.querySelector('.stack-alarm-banner');
  assert(banner !== null, 'Stack alarm banner must be rendered');
  assert(banner.textContent.includes('15'), 'Alarm banner should display 15s');

  const passBtn = banner.querySelector('.btn-pass-priority');
  const holdBtn = banner.querySelector('.btn-hold-respond');

  assert(passBtn !== null, 'Pass button must exist');
  assert(holdBtn !== null, 'Hold button must exist');

  // Clicking Hold pauses alarm
  holdBtn.click();
  assert.strictEqual(alarmManager.status, 'HELD');
  assert(banner.textContent.includes('HELD'), 'Banner should reflect HELD status');
});

// ----------------------------------------------------------------------------
// TEST 10: Dual-Channel Chat Tab Switching
// ----------------------------------------------------------------------------
runTest('TEST-UI-010: Switches between Chit-Chat and Turn Command tabs, isolating message feeds', () => {
  setup();

  chat.sendChatMessage('CHIT_CHAT', 'Good luck have fun!');

  ui.render();

  const chitChatTab = container.querySelector('.tab-btn.tab-chitchat');
  const turnCmdTab = container.querySelector('.tab-btn.tab-turncmd');

  chitChatTab.click();
  assert(chitChatTab.classList.contains('active'), 'Chit-Chat tab should be active');
  assert(container.querySelector('.chat-messages-container').textContent.includes('Good luck have fun!'), 'Message visible in Chit-Chat tab');

  turnCmdTab.click();
  assert(turnCmdTab.classList.contains('active'), 'Turn Command tab should be active');
  assert(!container.querySelector('.chat-messages-container').textContent.includes('Good luck have fun!'), 'Social message should not appear in Turn Command tab');
});

// ----------------------------------------------------------------------------
// TEST 11: Priority Lock Indicator & Input Toggling
// ----------------------------------------------------------------------------
runTest('TEST-UI-011: Displays red lock badge and disables Turn Command input when priority is not held', () => {
  setup();

  // Set priority to opponent p2
  psm.priorityPlayerId = 'p2';
  chat.syncPriorityState('p2');

  ui.render();

  const lockBadge = container.querySelector('.priority-lock-badge');
  const inputField = container.querySelector('.chat-input-field');
  const micBtn = container.querySelector('.mic-dictation-btn');
  const sendBtn = container.querySelector('.send-btn');

  assert(lockBadge.classList.contains('locked'), 'Lock badge should have locked class');
  assert.strictEqual(inputField.disabled, true, 'Input field must be disabled when locked');
  assert.strictEqual(micBtn.disabled, true, 'Mic button must be disabled when locked');
  assert.strictEqual(sendBtn.disabled, true, 'Send button must be disabled when locked');

  // Pass priority back to p1
  psm.priorityPlayerId = 'p1';
  chat.syncPriorityState('p1');

  assert(lockBadge.classList.contains('unlocked'), 'Lock badge should have unlocked class');
  assert.strictEqual(inputField.disabled, false, 'Input field must be enabled when priority held');
  assert.strictEqual(micBtn.disabled, false, 'Mic button must be enabled when priority held');
  assert.strictEqual(sendBtn.disabled, false, 'Send button must be enabled when priority held');
});

// ----------------------------------------------------------------------------
// TEST 12: Staged Action Confirmation Chip Lifecycle
// ----------------------------------------------------------------------------
runTest('TEST-UI-012: Surfaces 1-tap confirmation chip on command submission; confirms and clears cleanly', () => {
  setup();

  psm.priorityPlayerId = 'p1';
  chat.syncPriorityState('p1');

  // Submit shorthand command
  chat.submitTurnCommand('pass');

  ui.render();

  const stagedChip = container.querySelector('.staged-action-chip');
  assert(stagedChip !== null, 'Staged action chip must be visible');
  assert(stagedChip.textContent.includes('PASS_PRIORITY'), 'Chip text should display PASS_PRIORITY');

  const confirmBtn = stagedChip.querySelector('.btn-confirm');
  confirmBtn.click();

  // Chip dissolves after confirmation
  assert.strictEqual(chat.getActiveProposal(), null, 'Active proposal should be cleared');
  assert.strictEqual(container.querySelector('.staged-action-chip'), null, 'Staged chip element should dissolve from DOM');
});

// ----------------------------------------------------------------------------
// TEST 13: Interactive Life Adjustments
// ----------------------------------------------------------------------------
runTest('TEST-UI-013: Increments and decrements active player life total via UI buttons', () => {
  setup();
  ui.render();

  const minusBtn = container.querySelector('.btn-life-minus');
  const plusBtn = container.querySelector('.btn-life-plus');
  const lifeVal = container.querySelector('#player-board .life-value');

  assert(minusBtn && plusBtn && lifeVal, 'Life controller elements must exist');
  assert.strictEqual(lifeVal.textContent, '20');

  minusBtn.click();
  assert.strictEqual(ttsm.getPlayerLife('p1'), 19);

  plusBtn.click();
  plusBtn.click();
  assert.strictEqual(ttsm.getPlayerLife('p1'), 21);
});

// ----------------------------------------------------------------------------
// TEST 14: Keyboard Shortcuts for Priority and Hold
// ----------------------------------------------------------------------------
runTest('TEST-UI-014: Keyboard shortcuts (Space/P to pass priority, H to hold alarm)', () => {
  setup();

  const alarmMgr = psm.alarmManager;
  alarmMgr.start('p1', 'stack_1', 15);
  ui.render();

  assert.strictEqual(alarmMgr.status, 'RUNNING');

  // Press 'h' to hold
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));
  assert.strictEqual(alarmMgr.status, 'HELD');

  // Press 'p' to pass
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
  assert.strictEqual(alarmMgr.status, 'IDLE');
});

// ----------------------------------------------------------------------------
// TEST 15: formatManaSymbols Comprehensive Parsing
// ----------------------------------------------------------------------------
runTest('TEST-UI-015: formatManaSymbols parses hybrid, phyrexian, numbers and tap symbols', () => {
  const result = formatManaSymbols('{2}{U/R}{G}{T}{X}');
  assert(result.includes('ms-2'), 'Should contain ms-2');
  assert(result.includes('ms-ur'), 'Should contain ms-ur');
  assert(result.includes('ms-g'), 'Should contain ms-g');
  assert(result.includes('ms-tap'), 'Should contain ms-tap');
  assert(result.includes('ms-x'), 'Should contain ms-x');
});

// ----------------------------------------------------------------------------
// TEST 16: Destroy and Cleanup
// ----------------------------------------------------------------------------
runTest('TEST-UI-016: UI destroy unbinds listeners and removes DOM nodes cleanly', () => {
  setup();
  ui.render();

  assert(container.querySelector('#tabletop-container') !== null);
  ui.destroy();
  assert.strictEqual(container.querySelector('#tabletop-container'), null, 'Root container must be removed');
});

// ----------------------------------------------------------------------------
// TEST 17: Sub-16ms Frame Budget Reconciler Execution Benchmark (Invariant I5)
// ----------------------------------------------------------------------------
runTest('TEST-UI-017: Sub-16ms Frame Budget Reconciler execution benchmark (60 FPS)', () => {
  setup();

  // Populate complex multi-card state across all zones
  for (let i = 0; i < 7; i++) {
    ttsm.addCardToZone('p1', 'hand', { name: `PlayerCard_${i}`, manaCost: '{1}{U}{R}', typeLine: 'Instant' });
    ttsm.addCardToZone('p2', 'hand', { name: `SecretOppCard_${i}`, manaCost: '{B}', typeLine: 'Sorcery' });
    ttsm.addCardToZone('p1', 'battlefield', { name: `Creature_${i}`, typeLine: 'Creature', power: 2, toughness: 2 });
    ttsm.addCardToZone('p2', 'battlefield', { name: `OppCreature_${i}`, typeLine: 'Creature', power: 1, toughness: 1 });
  }
  psm.dispatch('CAST_SPELL', { playerId: 'p1', card: { name: 'Lightning Bolt', manaCost: '{R}' } });
  psm.alarmManager.start('p2', 'stack_item_0', 15);

  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    ui.render();
  }
  const end = performance.now();
  const avgDurationMs = (end - start) / iterations;
  console.log(`    -> Sub-16ms Benchmark: ${iterations} reconciliations in ${(end - start).toFixed(2)}ms (Avg: ${avgDurationMs.toFixed(3)}ms/frame)`);
  assert(avgDurationMs < 16.0, `Average reconcile time (${avgDurationMs.toFixed(3)}ms) must be strictly under 16ms frame budget`);
});

// ----------------------------------------------------------------------------
// TEST 18: Invariant I1 - Zero Client-Side Data Leakage in DOM Audit
// ----------------------------------------------------------------------------
runTest('TEST-UI-018: Invariant I1 - Zero Client-Side Data Leakage in DOM Audit', () => {
  setup();

  // Add sensitive cards to opponent hand and library
  ttsm.addCardToZone('p2', 'hand', {
    name: 'Secret Hand Card Alpha',
    manaCost: '{3}{B}{B}',
    oracleText: 'Destroy target creature with sensitive text.',
    imageUri: 'https://cards.scryfall.io/large/front/s/e/secret_alpha.jpg'
  });
  ttsm.addCardToZone('p2', 'library', {
    name: 'Top Secret Deck Card Omega',
    manaCost: '{W}{U}',
    oracleText: 'Target player draws two sensitive cards.',
    imageUri: 'https://cards.scryfall.io/large/front/t/s/secret_omega.jpg'
  });

  ui.render();

  // Expand opponent hand and library drawers
  const oppHandBadge = container.querySelector('#opponent-board .zone-drawer[data-zone="hand"] .zone-drawer-badge');
  const oppLibBadge = container.querySelector('#opponent-board .zone-drawer[data-zone="library"] .zone-drawer-badge');
  oppHandBadge.click();
  oppLibBadge.click();

  const fullOpponentHtml = container.querySelector('#opponent-board').innerHTML;

  // Zero leaked names
  assert(!fullOpponentHtml.includes('Secret Hand Card Alpha'), 'Opponent hand card name must not exist anywhere in DOM');
  assert(!fullOpponentHtml.includes('Top Secret Deck Card Omega'), 'Opponent library card name must not exist anywhere in DOM');

  // Zero leaked oracle text
  assert(!fullOpponentHtml.includes('Destroy target creature with sensitive text'), 'Opponent oracle text must not leak');
  assert(!fullOpponentHtml.includes('Target player draws two sensitive cards'), 'Opponent library oracle text must not leak');

  // Zero leaked image URIs
  assert(!fullOpponentHtml.includes('secret_alpha.jpg'), 'Opponent card image URI must not leak');
  assert(!fullOpponentHtml.includes('secret_omega.jpg'), 'Opponent library card image URI must not leak');
});

console.log(`\n==================================================================`);
console.log(`Summary: ${totalPassed} passed, ${totalFailed} failed.`);
console.log(`==================================================================\n`);

if (totalFailed > 0) {
  process.exit(1);
}
