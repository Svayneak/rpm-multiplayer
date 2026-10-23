/**
 * PregameStateMachine.js
 * Pre-Game Lifecycle State Machine (MTG CR 103)
 * 
 * Implements canonical MTG pre-game procedure:
 * 1. PREGAME_ROLL: Deterministic/seeded d20 roll-off for P1 and P2 (re-roll on tie). Winner gets choicePriority.
 * 2. PREGAME_CHOOSE_ORDER: Winner selects Play or Draw (CR 103.5). Sets startingPlayerId and activePlayerId.
 * 3. DRAW_INITIAL_HANDS: Both players draw 7 cards (CR 103.4).
 * 4. PREGAME_MULLIGAN: London Mulligan cycle in turn order (starter first, then opponent).
 *    If keep === false: increment mulliganCount, shuffle hand into library, draw 7,
 *    enter MULLIGAN_BOTTOMING to put N=mulliganCount cards on the bottom of library via PUT_ON_BOTTOM.
 * 5. GAME_ACTIVE: Both players have kept -> Turn 1, Round 1 (UNTAP -> UPKEEP -> PRECOMBAT_MAIN for starting player per CR 103.8a).
 * 
 * @module PregameStateMachine
 */

import { EventEmitter } from './EventEmitter.js';

export const PREGAME_STATES = Object.freeze({
  PREGAME_ROLL: 'PREGAME_ROLL',
  PREGAME_CHOOSE_ORDER: 'PREGAME_CHOOSE_ORDER',
  PREGAME_MULLIGAN: 'PREGAME_MULLIGAN',
  GAME_ACTIVE: 'GAME_ACTIVE'
});

export const MULLIGAN_SUBSTATES = Object.freeze({
  DECIDING: 'DECIDING',
  MULLIGAN_BOTTOMING: 'MULLIGAN_BOTTOMING',
  KEPT: 'KEPT'
});

/**
 * Generates authoritative d20 roll (1-20).
 * @param {Function} [customRng]
 * @returns {number}
 */
export function rollD20(customRng = null) {
  if (typeof customRng === 'function') {
    const val = customRng();
    if (typeof val === 'number') {
      return Math.floor(val * 20) + 1;
    }
  }
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto)
    ? globalThis.crypto
    : (typeof window !== 'undefined' && window.crypto ? window.crypto : null);

  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    cryptoObj.getRandomValues(buf);
    return (buf[0] % 20) + 1;
  }
  return Math.floor(Math.random() * 20) + 1;
}

export class PregameStateMachine extends EventEmitter {
  /**
   * @param {Object} [options={}]
   * @param {string[]} [options.players=['p1', 'p2']]
   * @param {Object} [options.tabletopState]
   * @param {Object} [options.priorityMachine]
   * @param {Function} [options.rng]
   * @param {string} [options.initialState='PREGAME_ROLL']
   */
  constructor(options = {}) {
    super();
    this.players = Array.isArray(options.players) && options.players.length > 0
      ? [...options.players]
      : ['p1', 'p2'];

    this.tabletopState = options.tabletopState || null;
    this.priorityMachine = options.priorityMachine || null;
    this.rng = options.rng || null;

    this.state = options.initialState || PREGAME_STATES.PREGAME_ROLL;
    this.rolls = {};
    this.rollWinnerId = null;
    this.choicePriority = null;
    this.startingPlayerId = null;
    this.activePlayerId = null;

    this.mulliganCount = {};
    this.mulliganStatus = {};
    this.playerSubStates = {};
    this.pendingBottomCount = {};
    this.currentDecidingPlayerId = null;

    for (const p of this.players) {
      this.mulliganCount[p] = 0;
      this.mulliganStatus[p] = 'PENDING';
      this.playerSubStates[p] = MULLIGAN_SUBSTATES.DECIDING;
      this.pendingBottomCount[p] = 0;
    }
  }

  /**
   * Resolves canonical player ID from alias ('p1'/'P1' -> players[0], 'p2'/'P2' -> players[1]).
   * @param {string} playerId
   * @returns {string}
   */
  resolvePlayerId(playerId) {
    if (!playerId) return this.players[0];
    if (this.players.includes(playerId)) return playerId;
    const norm = String(playerId).trim().toLowerCase();
    if (norm === 'p1' && this.players[0]) return this.players[0];
    if (norm === 'p2' && this.players[1]) return this.players[1];
    return playerId;
  }

  /**
   * Dispatches pre-game lifecycle action.
   * @param {string} actionType
   * @param {Object} [payload={}]
   * @returns {Object} Action result
   */
  dispatch(actionType, payload = {}) {
    switch (actionType) {
      case 'EXECUTE_STARTING_ROLL':
        return this.executeStartingRoll(payload);

      case 'SELECT_PLAY_OR_DRAW':
        return this.selectPlayOrDraw(payload);

      case 'DRAW_INITIAL_HANDS':
        return this.drawInitialHands(payload);

      case 'DECIDE_MULLIGAN':
        return this.decideMulligan(payload);

      case 'PUT_ON_BOTTOM':
        return this.putOnBottom(payload);

      default:
        throw new Error(`Unknown PregameStateMachine actionType: ${actionType}`);
    }
  }

  /**
   * Action 1: EXECUTE_STARTING_ROLL
   * Deterministic/seeded d20 rolls for P1 and P2 (re-rolls on tie).
   * Winner gets choicePriority.
   * @param {Object} [payload={}]
   * @returns {Object}
   */
  executeStartingRoll(payload = {}) {
    if (this.state !== PREGAME_STATES.PREGAME_ROLL) {
      throw new Error(`Cannot execute starting roll in state '${this.state}'`);
    }

    const p1 = this.players[0];
    const p2 = this.players[1] || 'p2';

    let r1, r2;
    if (payload.rolls && typeof payload.rolls[p1] === 'number' && typeof payload.rolls[p2] === 'number') {
      r1 = payload.rolls[p1];
      r2 = payload.rolls[p2];
    } else {
      do {
        r1 = rollD20(this.rng);
        r2 = rollD20(this.rng);
      } while (r1 === r2);
    }

    this.rolls = { [p1]: r1, [p2]: r2 };
    this.rollWinnerId = r1 > r2 ? p1 : p2;
    this.choicePriority = this.rollWinnerId;
    this.state = PREGAME_STATES.PREGAME_CHOOSE_ORDER;

    const result = {
      state: this.state,
      rolls: { ...this.rolls },
      winnerId: this.rollWinnerId,
      choicePriority: this.choicePriority
    };

    this.emit('STARTING_ROLL_RESOLVED', result);
    return result;
  }

  /**
   * Action 2: SELECT_PLAY_OR_DRAW
   * Sets startingPlayerId and activePlayerId.
   * @param {Object} payload
   * @param {string} payload.playerId
   * @param {'PLAY'|'DRAW'} payload.choice
   * @returns {Object}
   */
  selectPlayOrDraw(payload = {}) {
    if (this.state !== PREGAME_STATES.PREGAME_CHOOSE_ORDER) {
      throw new Error(`Cannot select play/draw order in state '${this.state}'`);
    }

    const playerId = this.resolvePlayerId(payload.playerId);
    if (this.choicePriority && playerId !== this.choicePriority) {
      throw new Error(`Player '${playerId}' does not hold choicePriority (winner is '${this.choicePriority}')`);
    }

    const choice = String(payload.choice || 'PLAY').toUpperCase();
    if (choice !== 'PLAY' && choice !== 'DRAW') {
      throw new Error(`Invalid play/draw choice '${payload.choice}': must be 'PLAY' or 'DRAW'`);
    }

    const opponentId = this.players.find(p => p !== playerId) || 'p2';
    const startingPlayerId = (choice === 'PLAY') ? playerId : opponentId;

    this.startingPlayerId = startingPlayerId;
    this.activePlayerId = startingPlayerId;

    if (this.priorityMachine) {
      this.priorityMachine.startingPlayerId = startingPlayerId;
      this.priorityMachine.activePlayerId = startingPlayerId;
      this.priorityMachine.priorityPlayerId = startingPlayerId;
    }
    if (this.tabletopState) {
      this.tabletopState.startingPlayerId = startingPlayerId;
      this.tabletopState.activePlayerId = startingPlayerId;
    }

    this.state = PREGAME_STATES.PREGAME_MULLIGAN;
    this.currentDecidingPlayerId = startingPlayerId;

    // Automatically draw initial 7-card hands on entering mulligan phase (CR 103.4)
    this.drawInitialHands();

    const result = {
      state: this.state,
      choice,
      startingPlayerId: this.startingPlayerId,
      activePlayerId: this.activePlayerId,
      currentDecidingPlayerId: this.currentDecidingPlayerId
    };

    this.emit('PLAY_OR_DRAW_SELECTED', result);
    return result;
  }

  /**
   * Action 3: DRAW_INITIAL_HANDS
   * Both players draw 7 cards (CR 103.4).
   * @param {Object} [payload={}]
   * @returns {Object}
   */
  drawInitialHands(payload = {}) {
    const handsDrawn = {};

    for (const pid of this.players) {
      this.mulliganCount[pid] = 0;
      this.mulliganStatus[pid] = 'PENDING';
      this.playerSubStates[pid] = MULLIGAN_SUBSTATES.DECIDING;
      this.pendingBottomCount[pid] = 0;

      if (this.tabletopState && typeof this.tabletopState.getPlayer === 'function') {
        const player = this.tabletopState.getPlayer(pid);
        if (player) {
          player.hand = player.hand || [];
          player.zones = player.zones || {};
          player.zones.hand = player.zones.hand || [];

          if (player.hand.length === 0 && Array.isArray(player.library) && player.library.length >= 7) {
            const drawn = player.library.splice(0, 7);
            player.hand.push(...drawn);
            player.zones.hand.push(...drawn);
          }
          handsDrawn[pid] = player.hand.length;
        }
      }
    }

    const result = { handsDrawn };
    this.emit('INITIAL_HANDS_DRAWN', result);
    return result;
  }

  /**
   * Action 4: DECIDE_MULLIGAN
   * Processed in turn order (starter first, then opponent).
   * keep === false: increment mulliganCount, shuffle hand into library, draw 7,
   * player sub-state MULLIGAN_BOTTOMING where they must pick N=mulliganCount cards via PUT_ON_BOTTOM.
   * When both keep === true and bottoming done -> GAME_ACTIVE.
   * 
   * @param {Object} payload
   * @param {string} payload.playerId
   * @param {boolean} payload.keep
   * @returns {Object}
   */
  decideMulligan(payload = {}) {
    if (this.state !== PREGAME_STATES.PREGAME_MULLIGAN) {
      throw new Error(`Cannot decide mulligan in state '${this.state}'`);
    }

    const playerId = this.resolvePlayerId(payload.playerId);
    if (this.currentDecidingPlayerId && playerId !== this.currentDecidingPlayerId) {
      throw new Error(`Player '${playerId}' cannot decide mulligan: waiting for current deciding player '${this.currentDecidingPlayerId}'`);
    }

    const keep = Boolean(payload.keep);

    if (!keep) {
      // CR 103.5 London Mulligan: Taking another mulligan reshuffles all 7 cards and draws a new 7-card hand;
      // bottoming only happens once the player decides to KEEP a hand with mulliganCount > 0.
      this.mulliganCount[playerId] = (this.mulliganCount[playerId] || 0) + 1;
      const count = this.mulliganCount[playerId];
      this.pendingBottomCount[playerId] = count;

      if (this.tabletopState && typeof this.tabletopState.getPlayer === 'function') {
        const player = this.tabletopState.getPlayer(playerId);
        if (player) {
          // 1. Shuffle hand cards back into library
          const handCards = Array.isArray(player.hand) ? [...player.hand] : [];
          player.hand = [];
          if (player.zones) player.zones.hand = [];

          player.library = [...(player.library || []), ...handCards];
          if (player.zones) player.zones.library = [...player.library];

          // Simple Fisher-Yates shuffle
          for (let i = player.library.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [player.library[i], player.library[j]] = [player.library[j], player.library[i]];
          }

          // 2. Draw 7 new cards
          const drawn = player.library.splice(0, Math.min(7, player.library.length));
          player.hand.push(...drawn);
          if (player.zones) player.zones.hand.push(...drawn);
        }
      }

      this.playerSubStates[playerId] = MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING;

      const result = {
        state: this.state,
        playerId,
        keep: false,
        mulliganCount: count,
        subState: MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING,
        cardsToBottomCount: count
      };

      this.emit('MULLIGAN_TAKEN', result);
      return result;
    }

    // keep === true: If the player took N > 0 mulligans and hasn't bottomed N cards for this hand yet,
    // either bottom payload.bottomCardIds inline or require PUT_ON_BOTTOM before completing KEEP.
    const pendingBottom = this.pendingBottomCount[playerId] || 0;
    if (pendingBottom > 0) {
      if (Array.isArray(payload.bottomCardIds) && payload.bottomCardIds.length === pendingBottom) {
        this.putOnBottom({ playerId, cardIds: payload.bottomCardIds });
      } else {
        this.playerSubStates[playerId] = MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING;
        throw new Error(`Player '${playerId}' must complete PUT_ON_BOTTOM (${pendingBottom} card(s)) before deciding again`);
      }
    }

    // keep === true: Player keeps opening hand
    this.mulliganStatus[playerId] = MULLIGAN_SUBSTATES.KEPT;
    this.playerSubStates[playerId] = MULLIGAN_SUBSTATES.KEPT;

    this.emit('MULLIGAN_KEPT', { playerId, mulliganCount: this.mulliganCount[playerId] });

    // Rotate mulligan decider in turn order: starter first, then opponent
    if (playerId === this.startingPlayerId) {
      const nextPlayer = this.players.find(p => p !== playerId);
      if (nextPlayer && this.mulliganStatus[nextPlayer] !== MULLIGAN_SUBSTATES.KEPT) {
        this.currentDecidingPlayerId = nextPlayer;
        return {
          state: this.state,
          playerId,
          keep: true,
          nextDecidingPlayerId: this.currentDecidingPlayerId
        };
      }
    }

    // Check if all players have kept and no bottoming pending
    return this._checkMulliganCompletion();
  }

  /**
   * Action 5: PUT_ON_BOTTOM
   * Puts N=mulliganCount cards on the bottom of the player's library.
   * @param {Object} payload
   * @param {string} payload.playerId
   * @param {string[]} payload.cardIds
   * @returns {Object}
   */
  putOnBottom(payload = {}) {
    const playerId = this.resolvePlayerId(payload.playerId);
    const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds : [];
    const requiredCount = this.pendingBottomCount[playerId] ?? this.mulliganCount[playerId] ?? 0;

    if (this.playerSubStates[playerId] !== MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING && requiredCount <= 0) {
      throw new Error(`Player '${playerId}' is not currently in MULLIGAN_BOTTOMING state`);
    }

    if (cardIds.length !== requiredCount) {
      throw new Error(`Player '${playerId}' must put exactly ${requiredCount} card(s) on the bottom, received ${cardIds.length}`);
    }

    if (this.tabletopState && typeof this.tabletopState.getPlayer === 'function') {
      const player = this.tabletopState.getPlayer(playerId);
      if (player && Array.isArray(player.hand)) {
        const bottomed = [];
        player.hand = player.hand.filter(c => {
          const id = c.instanceId || c.id;
          if (cardIds.includes(id)) {
            bottomed.push(c);
            return false;
          }
          return true;
        });

        if (player.zones && Array.isArray(player.zones.hand)) {
          player.zones.hand = player.zones.hand.filter(c => !cardIds.includes(c.instanceId || c.id));
        }

        player.library = [...(player.library || []), ...bottomed];
        if (player.zones) player.zones.library = [...player.library];
      }
    }

    // Bottoming complete -> clear pendingBottomCount and transition sub-state
    this.pendingBottomCount[playerId] = 0;
    this.playerSubStates[playerId] = MULLIGAN_SUBSTATES.DECIDING;

    this.emit('CARDS_PUT_ON_BOTTOM', { playerId, cardIds, remainingHandSize: 7 - requiredCount });

    // In London Mulligan, bottoming occurs after taking mulligan, so player now decides whether to keep this hand
    return {
      state: this.state,
      playerId,
      subState: this.playerSubStates[playerId],
      cardsBottomed: cardIds.length
    };
  }

  /**
   * Evaluates if London Mulligan cycle has concluded for all seated players.
   * When both keep === true and bottoming done -> transitions to GAME_ACTIVE (CR 103.8a).
   * @private
   */
  _checkMulliganCompletion() {
    const allKept = this.players.every(p => this.mulliganStatus[p] === MULLIGAN_SUBSTATES.KEPT);
    const anyBottoming = this.players.some(p => this.playerSubStates[p] === MULLIGAN_SUBSTATES.MULLIGAN_BOTTOMING);

    if (allKept && !anyBottoming) {
      this.state = PREGAME_STATES.GAME_ACTIVE;
      this.currentDecidingPlayerId = null;

      // Initialize Turn 1, Round 1 for starting player per MTG CR 103.8a
      const starter = this.startingPlayerId || this.players[0];

      if (this.priorityMachine) {
        this.priorityMachine.roundNumber = 1;
        this.priorityMachine.turnNumber = 1;
        this.priorityMachine.activePlayerId = starter;
        this.priorityMachine.priorityPlayerId = starter;
        this.priorityMachine.startingPlayerId = starter;
        this.priorityMachine.currentPhaseStep = 'UNTAP';

        if (typeof this.priorityMachine.nextPhase === 'function') {
          // Per CR 103.8a: advance starting player through UNTAP -> UPKEEP -> PRECOMBAT_MAIN
          this.priorityMachine.nextPhase(starter);
        }
      }

      if (this.tabletopState) {
        this.tabletopState.roundNumber = 1;
        this.tabletopState.turnNumber = 1;
        this.tabletopState.activePlayerId = starter;
        this.tabletopState.startingPlayerId = starter;
      }

      const activeResult = {
        state: PREGAME_STATES.GAME_ACTIVE,
        startingPlayerId: starter,
        activePlayerId: starter,
        turnNumber: 1,
        roundNumber: 1,
        currentPhaseStep: this.priorityMachine?.currentPhaseStep || 'PRECOMBAT_MAIN'
      };

      this.emit('GAME_ACTIVE', activeResult);
      return activeResult;
    }

    return {
      state: this.state,
      currentDecidingPlayerId: this.currentDecidingPlayerId,
      mulliganStatus: { ...this.mulliganStatus }
    };
  }
}
