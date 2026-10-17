/**
 * DualChannelChat.js
 * Dual-Channel Priority Chat & Fast-Path Action Bus with Staged Intent Chips
 * 
 * Separates Chit-Chat (unparsed, open banter) from Turn Command (strictly priority-gated).
 * Implements Staged Action Proposals, 1-tap confirmation/cancellation, and Speech integration.
 * 
 * Part of RPM Multiplayer - Feature 5 & 6
 * Document ID: SPEC-RPM-CHAT-005
 * 
 * @module DualChannelChat
 */

import { ActionLexer, ActionLexerError } from './ActionLexer.js';

/**
 * Thrown when a player attempts to post or dictate to Turn Command
 * without currently holding game priority.
 */
export class PriorityGatedChatError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'PriorityGatedChatError';
    this.details = {
      attemptedPlayerId: details.attemptedPlayerId || null,
      priorityPlayerId: details.priorityPlayerId || null,
      currentPhaseStep: details.currentPhaseStep || null,
      timestamp: Date.now(),
      ...details
    };
  }
}

/**
 * Thrown when attempting to confirm an expired or already resolved proposal.
 */
export class ProposalExpiredError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details={}]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProposalExpiredError';
    this.details = details;
  }
}

export { ActionLexerError };

/**
 * DualChannelChat coordinates social chat and priority-gated turn actions.
 */
export class DualChannelChat {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.sessionId]
   * @param {string} [options.myPlayerId='p1']
   * @param {Object} [options.priorityStateMachine]
   * @param {Object} [options.tabletopStateManager]
   * @param {Object} [options.speechService]
   * @param {number} [options.proposalTtlMs=30000]
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId || `chat_${Date.now()}`;
    this.myPlayerId = options.myPlayerId || 'p1';
    this.priorityStateMachine = options.priorityStateMachine || null;
    this.tabletopStateManager = options.tabletopStateManager || null;
    this.speechService = options.speechService || null;
    this.proposalTtlMs = options.proposalTtlMs || 30000;

    this._priorityPlayerId = options.priorityPlayerId || null;
    this.chitChatMessages = [];
    this.turnCommandMessages = [];
    this.activeProposal = null;
    this.proposalHistory = [];
    this._subscribers = new Set();

    // Hook into PriorityStateMachine if provided
    if (this.priorityStateMachine && typeof this.priorityStateMachine.subscribe === 'function') {
      this._psmUnsubscribe = this.priorityStateMachine.subscribe((event) => {
        if (event.type === 'PRIORITY_CHANGED' || event.type === 'PHASE_STEP_CHANGED' || event.type === 'TURN_ADVANCED') {
          const currentPriority = this.priorityStateMachine.getPriorityPlayerId?.() || this.priorityStateMachine.priorityPlayerId;
          this.syncPriorityState(currentPriority);
        }
      });
    }

    if (this.speechService) {
      this.attachSpeechService(this.speechService);
    }
  }

  // ==========================================
  // Priority Gating & State Synchronization
  // ==========================================

  /**
   * Returns current priority holder player ID.
   * @returns {string}
   */
  getPriorityPlayerId() {
    if (this._priorityPlayerId !== null && this._priorityPlayerId !== undefined) {
      return this._priorityPlayerId;
    }
    if (this.priorityStateMachine) {
      return typeof this.priorityStateMachine.getPriorityPlayerId === 'function'
        ? this.priorityStateMachine.getPriorityPlayerId()
        : this.priorityStateMachine.priorityPlayerId;
    }
    return this.myPlayerId;
  }

  /**
   * Evaluates if Turn Command input is locked for local player.
   * Locked if local player does NOT hold priority.
   * @returns {boolean}
   */
  isInputLocked() {
    return this.getPriorityPlayerId() !== this.myPlayerId;
  }

  /**
   * Synchronizes priority state and emits lock change events if modified.
   * @param {string} priorityPlayerId
   */
  syncPriorityState(priorityPlayerId) {
    const wasLocked = this.isInputLocked();
    this._priorityPlayerId = priorityPlayerId;
    const nowLocked = this.isInputLocked();

    if (wasLocked !== nowLocked) {
      this.emit('PRIORITY_LOCK_CHANGED', {
        myPlayerId: this.myPlayerId,
        priorityPlayerId,
        isLocked: nowLocked
      });
    }
  }

  // ==========================================
  // Channel Operations
  // ==========================================

  /**
   * Sends a message to a channel ('CHIT_CHAT' or 'TURN_COMMAND').
   * 
   * @param {'CHIT_CHAT'|'TURN_COMMAND'} channel
   * @param {string} text
   * @param {Object} [metadata={}]
   * @returns {Object} Sent ChatMessage or DraftActionProposal
   */
  sendChatMessage(channel, text, metadata = {}) {
    if (channel === 'TURN_COMMAND') {
      return this.submitTurnCommand(text, metadata);
    }

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      sessionId: this.sessionId,
      channel: 'CHIT_CHAT',
      senderId: metadata.senderId || this.myPlayerId,
      senderName: metadata.senderName || metadata.senderId || this.myPlayerId,
      text,
      timestamp: Date.now(),
      status: 'DELIVERED',
      metadata
    };

    this.chitChatMessages.push(message);
    this.emit('CHAT_MESSAGE_SENT', { message });
    return message;
  }

  /**
   * Submits a turn command for local player (convenience shorthand).
   * 
   * @param {string} text
   * @param {Object} [metadata={}]
   * @returns {Object} DraftActionProposal
   */
  submitTurnCommand(text, metadata = {}) {
    return this.sendTurnCommand(this.myPlayerId, text, metadata);
  }

  /**
   * Submits a turn command for a specific player ID.
   * Strictly priority-gated.
   * 
   * @param {string} playerIdOrText
   * @param {string|Object} [maybeText]
   * @param {Object} [metadata={}]
   * @returns {Object} DraftActionProposal
   */
  sendTurnCommand(playerIdOrText, maybeText, metadata = {}) {
    let playerId = this.myPlayerId;
    let text = playerIdOrText;
    let meta = metadata;

    if (typeof maybeText === 'string') {
      playerId = playerIdOrText;
      text = maybeText;
    } else if (typeof maybeText === 'object' && maybeText !== null) {
      meta = maybeText;
    }

    const currentPriority = this.getPriorityPlayerId();
    if (playerId !== currentPriority) {
      this.emit('PRIORITY_GATED_REJECTED', {
        attemptedPlayerId: playerId,
        priorityPlayerId: currentPriority,
        rawText: text
      });
      throw new PriorityGatedChatError(
        `Action rejected: Player '${playerId}' does not hold priority (held by '${currentPriority}').`,
        {
          attemptedPlayerId: playerId,
          priorityPlayerId: currentPriority,
          currentPhaseStep: this.priorityStateMachine?.currentPhaseStep || null,
          text
        }
      );
    }

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      sessionId: this.sessionId,
      channel: 'TURN_COMMAND',
      senderId: playerId,
      senderName: meta.senderName || playerId,
      text,
      timestamp: Date.now(),
      status: 'PROCESSED',
      metadata: meta
    };
    this.turnCommandMessages.push(message);
    this.emit('TURN_COMMAND_SUBMITTED', { message });

    // Tabletop Context
    const handCards = meta.handCards || this._getPlayerHandCards(playerId);
    const battlefieldPermanents = meta.battlefieldPermanents || this._getBattlefieldPermanents();

    const context = {
      sessionId: this.sessionId,
      activePlayerId: playerId,
      handCards,
      battlefieldPermanents,
      ...meta.context
    };

    const proposal = ActionLexer.parse(text, context);
    proposal.sessionId = this.sessionId;
    proposal.playerId = playerId;
    if (meta && typeof meta === 'object') {
      proposal.metadata = meta;
    }

    this.activeProposal = proposal;

    if (proposal.status === 'AMBIGUOUS') {
      this.emit('ACTION_PROPOSAL_AMBIGUITY', {
        rawText: text,
        candidates: proposal.candidates || []
      });
    } else {
      this.emit('ACTION_PROPOSAL_GENERATED', { proposal });
    }

    return proposal;
  }

  // ==========================================
  // Proposal Lifecycle & Staged Chips
  // ==========================================

  /**
   * Retrieves the current staged action proposal.
   * @returns {Object|null}
   */
  getActiveProposal() {
    return this.activeProposal;
  }

  /**
   * Confirms a staged action proposal (1-Tap confirm chip).
   * Verifies priority at moment of confirmation, dispatches mutating actions
   * to TabletopStateManager and PriorityStateMachine.
   * 
   * @param {string} proposalId
   * @returns {{ success: boolean, proposal: Object }}
   */
  confirmProposal(proposalId) {
    const proposal = this.activeProposal;
    if (!proposal || proposal.id !== proposalId) {
      throw new Error(`Proposal not found or inactive: ${proposalId}`);
    }

    // Expiration check
    if (Date.now() > proposal.expiresAt) {
      proposal.status = 'CANCELLED';
      this.proposalHistory.push(proposal);
      this.activeProposal = null;
      this.emit('ACTION_PROPOSAL_EXPIRED', { proposalId, proposal });
      throw new ProposalExpiredError(`Proposal '${proposalId}' has expired.`, {
        proposalId,
        expiresAt: proposal.expiresAt
      });
    }

    // Dynamic priority re-verification at confirmation moment
    const currentPriority = this.getPriorityPlayerId();
    if (proposal.playerId !== currentPriority) {
      this.emit('PRIORITY_GATED_REJECTED', {
        attemptedPlayerId: proposal.playerId,
        priorityPlayerId: currentPriority,
        rawText: proposal.rawText
      });
      throw new PriorityGatedChatError(
        `Cannot confirm proposal: Player '${proposal.playerId}' no longer holds priority (held by '${currentPriority}').`,
        {
          attemptedPlayerId: proposal.playerId,
          priorityPlayerId: currentPriority
        }
      );
    }

    // Dispatch mutating action to TabletopStateManager & PriorityStateMachine
    this._dispatchActionToEngines(proposal);

    proposal.status = 'CONFIRMED';
    this.proposalHistory.push(proposal);
    this.activeProposal = null;

    this.emit('ACTION_PROPOSAL_CONFIRMED', {
      proposalId: proposal.id,
      actionType: proposal.actionType,
      params: proposal.params,
      proposal
    });

    return { success: true, proposal };
  }

  /**
   * Alias for confirmProposal(proposalId)
   * @param {string} proposalId
   * @returns {{ success: boolean, proposal: Object }}
   */
  confirmAction(proposalId) {
    return this.confirmProposal(proposalId);
  }

  /**
   * Cancels a staged proposal without mutating any game state.
   * 
   * @param {string} proposalId
   * @returns {Object|null} Cancelled proposal
   */
  cancelProposal(proposalId) {
    if (!this.activeProposal || this.activeProposal.id !== proposalId) {
      return null;
    }
    const proposal = this.activeProposal;
    proposal.status = 'CANCELLED';
    this.proposalHistory.push(proposal);
    this.activeProposal = null;

    this.emit('ACTION_PROPOSAL_CANCELLED', {
      proposalId,
      proposal
    });

    return proposal;
  }

  /**
   * Cancels proposal for inline editing in Turn Command input field.
   * 
   * @param {string} proposalId
   * @returns {{ text: string }|null}
   */
  editProposal(proposalId) {
    if (!this.activeProposal || this.activeProposal.id !== proposalId) {
      return null;
    }
    const proposal = this.activeProposal;
    proposal.status = 'EDITED';
    const text = proposal.rawText;
    this.proposalHistory.push(proposal);
    this.activeProposal = null;

    return { text };
  }

  /**
   * Resolves an ambiguous proposal with a selected candidate ID.
   * 
   * @param {string} proposalId
   * @param {string} selectedCandidateId
   * @returns {Object} Resolved proposal
   */
  resolveAmbiguity(proposalId, selectedCandidateId) {
    if (!this.activeProposal || this.activeProposal.id !== proposalId) {
      throw new Error(`Proposal '${proposalId}' not found or not active.`);
    }

    this.activeProposal = ActionLexer.resolveCandidate(this.activeProposal, selectedCandidateId);
    this.emit('ACTION_PROPOSAL_GENERATED', { proposal: this.activeProposal });
    return this.activeProposal;
  }

  // ==========================================
  // Speech Recognition Service Integration
  // ==========================================

  /**
   * Binds a SpeechRecognitionService to dictate into Turn Command.
   * 
   * @param {Object} speechService
   */
  attachSpeechService(speechService) {
    this.speechService = speechService;
    if (speechService && typeof speechService === 'object') {
      const origFinal = speechService.onFinal;
      speechService.onFinal = (text) => {
        if (typeof origFinal === 'function') {
          origFinal(text);
        }
        if (text && !this.isInputLocked()) {
          try {
            this.submitTurnCommand(text, { isVoiceDictated: true });
          } catch (err) {
            this.emit('SPEECH_SUBMISSION_ERROR', { error: err.message });
          }
        }
      };
    }
  }

  // ==========================================
  // Observer Pattern & Event Emitter
  // ==========================================

  /**
   * Subscribes a listener to DualChannelChat events.
   * 
   * @param {Function} listener
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    if (typeof listener === 'function') {
      this._subscribers.add(listener);
    }
    return () => {
      this._subscribers.delete(listener);
    };
  }

  /**
   * Unsubscribes a listener.
   * 
   * @param {Function} listener
   */
  unsubscribe(listener) {
    this._subscribers.delete(listener);
  }

  /**
   * Emits an event to all subscribers.
   * 
   * @param {string} type
   * @param {Object} [payload={}]
   */
  emit(type, payload = {}) {
    const event = {
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      payload
    };
    for (const sub of this._subscribers) {
      try {
        sub(event);
      } catch (err) {
        console.error(`Error in subscriber for ${type}:`, err);
      }
    }
  }

  /**
   * Returns a serializable snapshot of DualChannelChat state.
   * 
   * @returns {Object}
   */
  getState() {
    return {
      sessionId: this.sessionId,
      myPlayerId: this.myPlayerId,
      priorityPlayerId: this.getPriorityPlayerId(),
      isInputLocked: this.isInputLocked(),
      chitChatMessages: [...this.chitChatMessages],
      turnCommandMessages: [...this.turnCommandMessages],
      activeProposal: this.activeProposal,
      proposalHistory: [...this.proposalHistory]
    };
  }

  // ==========================================
  // Internal Helpers
  // ==========================================

  _getPlayerHandCards(playerId) {
    if (this.tabletopStateManager && typeof this.tabletopStateManager.getPlayer === 'function') {
      try {
        const player = this.tabletopStateManager.getPlayer(playerId);
        return player.hand || [];
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  _getBattlefieldPermanents() {
    if (!this.tabletopStateManager || !this.tabletopStateManager.players) {
      return [];
    }
    const permanents = [];
    for (const [playerId, player] of Object.entries(this.tabletopStateManager.players)) {
      const bf = player.battlefield || {};
      for (const sub of ['creatures', 'planeswalkers', 'noncreatures', 'lands']) {
        if (Array.isArray(bf[sub])) {
          for (const card of bf[sub]) {
            permanents.push({
              targetId: card.instanceId,
              targetType: 'PERMANENT',
              targetName: card.name,
              name: card.name,
              controllerId: playerId,
              zone: 'BATTLEFIELD'
            });
          }
        }
      }
    }
    return permanents;
  }

  _dispatchActionToEngines(proposal) {
    const { actionType, playerId, params } = proposal;

    switch (actionType) {
      case 'PASS_PRIORITY':
        if (this.priorityStateMachine && typeof this.priorityStateMachine.dispatch === 'function') {
          this.priorityStateMachine.dispatch('PASS_PRIORITY', { playerId });
        }
        break;

      case 'ADJUST_LIFE':
        if (this.tabletopStateManager && typeof this.tabletopStateManager.adjustLife === 'function') {
          if (params.lifeOperation === 'SET') {
            this.tabletopStateManager.adjustLife(playerId, { targetValue: params.lifeAmount });
          } else if (params.lifeOperation === 'DELTA') {
            this.tabletopStateManager.adjustLife(playerId, { delta: params.lifeDelta });
          }
        }
        break;

      case 'PLAY_LAND':
        if (this.tabletopStateManager && typeof this.tabletopStateManager.playLand === 'function') {
          let instanceId = params.cardId;
          if (!instanceId) {
            const player = this.tabletopStateManager.getPlayer?.(playerId);
            const found = player?.hand?.find(c =>
              c.name.toLowerCase() === (params.cardName || '').toLowerCase()
            );
            if (found) instanceId = found.instanceId;
          }
          if (instanceId) {
            this.tabletopStateManager.playLand(playerId, instanceId);
          }
        }
        break;

      case 'CAST_SPELL':
        if (this.tabletopStateManager && typeof this.tabletopStateManager.castSpell === 'function') {
          let instanceId = params.cardId;
          if (!instanceId) {
            const player = this.tabletopStateManager.getPlayer?.(playerId);
            const found = player?.hand?.find(c =>
              c.name.toLowerCase() === (params.cardName || '').toLowerCase()
            );
            if (found) instanceId = found.instanceId;
          }
          if (instanceId) {
            this.tabletopStateManager.castSpell(playerId, instanceId, {
              targets: params.targets
            });
          }
        }
        if (this.priorityStateMachine && typeof this.priorityStateMachine.dispatch === 'function') {
          this.priorityStateMachine.dispatch('CAST_SPELL', {
            playerId,
            card: { name: params.cardName, id: params.cardId },
            targets: params.targets
          });
        }
        break;

      default:
        break;
    }
  }
}

export default DualChannelChat;
