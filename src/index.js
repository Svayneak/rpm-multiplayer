/**
 * RPM Multiplayer - Core Engine, Tabletop State, and Stack & Priority Flow
 * 
 * Entry point module exporting DeckParser, ScryfallService, Cache adapters,
 * ZoneModel, TabletopStateManager, Fog-of-War Projection, PriorityStateMachine,
 * StackAlarmManager, DualChannelChat, ActionLexer, SpeechRecognitionService,
 * and related constants and error classes.
 * 
 * Specifications:
 * - SPEC-RPM-INGEST-001   (Feature 1 & 2)
 * - SPEC-RPM-ZONE-003     (Feature 3)
 * - SPEC-RPM-PRIORITY-004 (Feature 4)
 * - SPEC-RPM-CHAT-005     (Feature 5 & 6)
 * 
 * @module rpm-multiplayer
 */

export {
  parseDecklist,
  REGEX_DECK_COMPREHENSIVE,
  REGEX_DECK_SIMPLE
} from './DeckParser.js';

export {
  ScryfallService,
  MemoryCacheAdapter,
  LocalStorageCacheAdapter
} from './ScryfallService.js';

export {
  ZoneModel,
  classifySubzone,
  generateInstanceId,
  shuffleArray,
  resetCardState,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError,
  PlayerNotFoundError
} from './ZoneModel.js';

export {
  TabletopStateManager,
  projectState,
  LandLimitExceededError,
  PhaseTimingError
} from './TabletopStateManager.js';

export {
  PriorityStateMachine,
  PriorityViolationError,
  CheckpointJournal,
  PHASE_STEPS,
  SEVEN_PHASE_STEPS,
  TWELVE_PHASE_STEPS,
  generateStackItemId,
  generateCheckpointId
} from './PriorityStateMachine.js';

export {
  StackAlarmManager
} from './StackAlarmManager.js';

export {
  DualChannelChat,
  PriorityGatedChatError,
  ProposalExpiredError,
  SpectatorPermissionError
} from './DualChannelChat.js';

export {
  ActionLexer,
  ActionLexerError,
  generateProposalId
} from './ActionLexer.js';

export {
  SpeechRecognitionService
} from './SpeechRecognitionService.js';

export {
  TabletopUI
} from './view/TabletopUI.js';

export {
  CardOverlayModal,
  formatManaSymbols
} from './view/CardOverlayModal.js';

export {
  createRelayServer,
  generateRoomCode,
  WebSocketConnection,
  RoomSession,
  CROCKFORD_ALPHABET,
  timingSafeEqualString
} from './relay.js';

export {
  RelayClient
} from './RelayClient.js';

export {
  PerkCatalog,
  PERK_KEYS,
  RPBD_OPTIONS,
  getPerkDefinition,
  resolveRoll,
  matchRollToPerk,
  getLegalTargets,
  findLegalTargets,
  hasLegalTargets,
  executePerkEffect
} from './PerkCatalog.js';

export {
  RandomPerkEngine,
  executeAuthoritativeRoll
} from './RandomPerkEngine.js';

export {
  StorageAdapter,
  calculatePayloadBytes,
  validateAndGuardGuidelineQuota
} from './StorageAdapter.js';

export {
  DeckbuilderAI,
  TAG_COLORS,
  TAG_ARCHETYPES,
  TAG_MECHANICS,
  TAG_TYPES,
  PRECOMPILED_ARCHETYPES,
  BEGINNER_DECKS,
  STARTER_DECKS,
  STARTER_CARD_METADATA,
  getHydratedCardMetadata,
  dealStartingHands,
  formatDeckForExport,
  resolveActiveGuidelines,
  calculateCompositeScore,
  updateTopShowcase
} from './DeckbuilderAI.js';

export {
  ProfileManager,
  UserProfileManager,
  EloCalculator,
  ChiptuneSynthesizer,
  VictoryFanfareEngine,
  VictoryFanfare,
  AudioEngine,
  validateFanfareConfig,
  parseYouTubeVideoId,
  parseYouTubeId,
  evaluateDeckSlots,
  primeAudio,
  renderFallbackBanner,
  createDefaultProfile,
  createDefaultFanfareConfig,
  DECK_SLOT_MILESTONES,
  CHIPTUNE_NOTES,
  DEFAULT_PROFILE_ELO,
  DEFAULT_K_FACTOR,
  MAX_MATCH_HISTORY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MIN_FANFARE_DURATION,
  MAX_FANFARE_DURATION,
  DEFAULT_WATCHDOG_TIMEOUT_MS
} from './VictoryFanfare.js';

export {
  RPMAppController,
  AppController
} from './app.js';

export {
  PerkinsAgent,
  PERKINS_DEFAULT_CONFIG,
  PERKINS_COACH_DIALOGUES
} from './PerkinsAgent.js';

export {
  DeckValidator,
  VALIDATION_ERRORS,
  ORACLE_UNLIMITED_CARDS,
  MODERN_BANLIST,
  BASIC_LANDS
} from './DeckValidator.js';

export {
  LobbyManager,
  LOBBY_STATUS
} from './LobbyManager.js';

export {
  MatchmakingQueue,
  WATCHDOG_THRESHOLD_SECONDS
} from './MatchmakingQueue.js';

export {
  TabRouter,
  TABS,
  LOCKED_TABS_DURING_MATCH
} from './view/TabRouter.js';

export {
  TurnRollOffManager,
  generateAuthoritativeD20
} from './TurnRollOffManager.js';

export {
  SPANISH_COLOR_LAND_MAP,
  REGEX_ROLL_DICE_BILINGUAL
} from './ActionLexer.js';

export {
  AuthManager,
  STARTER_ARCHETYPES,
  STARTER_ALIASES,
  getStarterDeck,
  calculateAge,
  generateUUID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  AUTH_STORAGE_KEY,
  TELEMETRY_STORAGE_KEY
} from './AuthManager.js';

export {
  DiceCanvas,
  diceCanvas,
  is3DSupported
} from './view/DiceCanvas.js';

export {
  DiceShaker,
  diceShaker
} from './view/DiceShaker.js';

export {
  MulliganEngine,
  shuffleLibrary,
  evaluatePerkinsMulligan,
  selectPerkinsBottomCards,
  MulliganTracker
} from './MulliganEngine.js';

export {
  CostModificationEngine,
  parseManaCost,
  formatManaCost
} from './CostModificationEngine.js';

export {
  AbilityEngine,
  CONTINUOUS_LAYERS
} from './AbilityEngine.js';

export {
  ZoneTransitionMatrix,
  ZONES
} from './ZoneTransitionMatrix.js';

export {
  CombatDamageEngine
} from './CombatDamageEngine.js';

export {
  StateBasedActionsEngine
} from './StateBasedActionsEngine.js';

export {
  MulliganModal
} from './view/MulliganModal.js';

export {
  SearchSelectGridModal
} from './view/SearchSelectGridModal.js';

export {
  TargetSelectorModal
} from './view/TargetSelectorModal.js';

export {
  PermanentActionDrawer
} from './view/PermanentActionDrawer.js';

export {
  DamageAssignmentModal
} from './view/DamageAssignmentModal.js';

import {
  AuthManager,
  STARTER_ARCHETYPES,
  STARTER_ALIASES,
  getStarterDeck,
  calculateAge,
  generateUUID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  AUTH_STORAGE_KEY,
  TELEMETRY_STORAGE_KEY
} from './AuthManager.js';
import { DiceCanvas, diceCanvas, is3DSupported } from './view/DiceCanvas.js';
import { DiceShaker, diceShaker } from './view/DiceShaker.js';
import { RPMAppController, AppController } from './app.js';
import { PerkinsAgent, PERKINS_DEFAULT_CONFIG, PERKINS_COACH_DIALOGUES } from './PerkinsAgent.js';
import { parseDecklist, REGEX_DECK_COMPREHENSIVE, REGEX_DECK_SIMPLE } from './DeckParser.js';
import { ScryfallService, MemoryCacheAdapter, LocalStorageCacheAdapter } from './ScryfallService.js';
import {
  ZoneModel,
  classifySubzone,
  generateInstanceId,
  shuffleArray,
  resetCardState,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError,
  PlayerNotFoundError
} from './ZoneModel.js';
import { TabletopStateManager, projectState } from './TabletopStateManager.js';
import {
  PriorityStateMachine,
  PriorityViolationError,
  CheckpointJournal,
  PHASE_STEPS,
  generateStackItemId,
  generateCheckpointId
} from './PriorityStateMachine.js';
import { StackAlarmManager } from './StackAlarmManager.js';
import {
  DualChannelChat,
  PriorityGatedChatError,
  ProposalExpiredError
} from './DualChannelChat.js';
import {
  ActionLexer,
  ActionLexerError,
  generateProposalId
} from './ActionLexer.js';
import { SpeechRecognitionService } from './SpeechRecognitionService.js';
import { TabletopUI } from './view/TabletopUI.js';
import { CardOverlayModal, formatManaSymbols } from './view/CardOverlayModal.js';
import {
  createRelayServer,
  generateRoomCode,
  WebSocketConnection,
  RoomSession,
  CROCKFORD_ALPHABET,
  timingSafeEqualString
} from './relay.js';
import { RelayClient } from './RelayClient.js';
import { EventEmitter } from './EventEmitter.js';
import PerkCatalog, {
  PERK_KEYS,
  RPBD_OPTIONS,
  getPerkDefinition,
  resolveRoll,
  matchRollToPerk,
  getLegalTargets,
  findLegalTargets,
  hasLegalTargets,
  executePerkEffect
} from './PerkCatalog.js';
import { RandomPerkEngine, executeAuthoritativeRoll } from './RandomPerkEngine.js';
import { StorageAdapter, calculatePayloadBytes, validateAndGuardGuidelineQuota } from './StorageAdapter.js';
import {
  DeckbuilderAI,
  TAG_COLORS,
  TAG_ARCHETYPES,
  TAG_MECHANICS,
  TAG_TYPES,
  PRECOMPILED_ARCHETYPES,
  BEGINNER_DECKS,
  formatDeckForExport,
  resolveActiveGuidelines,
  calculateCompositeScore,
  updateTopShowcase
} from './DeckbuilderAI.js';
import {
  ProfileManager,
  UserProfileManager,
  EloCalculator,
  ChiptuneSynthesizer,
  VictoryFanfareEngine,
  VictoryFanfare,
  AudioEngine,
  validateFanfareConfig,
  parseYouTubeVideoId,
  parseYouTubeId,
  evaluateDeckSlots,
  primeAudio,
  renderFallbackBanner,
  createDefaultProfile,
  createDefaultFanfareConfig,
  DECK_SLOT_MILESTONES,
  CHIPTUNE_NOTES,
  DEFAULT_PROFILE_ELO,
  DEFAULT_K_FACTOR,
  MAX_MATCH_HISTORY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MIN_FANFARE_DURATION,
  MAX_FANFARE_DURATION,
  DEFAULT_WATCHDOG_TIMEOUT_MS
} from './VictoryFanfare.js';

import {
  DeckValidator,
  VALIDATION_ERRORS,
  ORACLE_UNLIMITED_CARDS,
  MODERN_BANLIST,
  BASIC_LANDS
} from './DeckValidator.js';
import {
  LobbyManager,
  LOBBY_STATUS
} from './LobbyManager.js';
import {
  MatchmakingQueue,
  WATCHDOG_THRESHOLD_SECONDS
} from './MatchmakingQueue.js';
import {
  TabRouter,
  TABS,
  LOCKED_TABS_DURING_MATCH
} from './view/TabRouter.js';
import {
  TurnRollOffManager,
  generateAuthoritativeD20
} from './TurnRollOffManager.js';

export default {
  ProfileManager,
  UserProfileManager,
  EloCalculator,
  ChiptuneSynthesizer,
  VictoryFanfareEngine,
  VictoryFanfare,
  AudioEngine,
  validateFanfareConfig,
  parseYouTubeVideoId,
  parseYouTubeId,
  evaluateDeckSlots,
  primeAudio,
  renderFallbackBanner,
  createDefaultProfile,
  createDefaultFanfareConfig,
  DECK_SLOT_MILESTONES,
  CHIPTUNE_NOTES,
  DEFAULT_PROFILE_ELO,
  DEFAULT_K_FACTOR,
  MAX_MATCH_HISTORY_LENGTH,
  MAX_PAYLOAD_BYTES,
  MIN_FANFARE_DURATION,
  MAX_FANFARE_DURATION,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
  StorageAdapter,
  calculatePayloadBytes,
  validateAndGuardGuidelineQuota,
  DeckbuilderAI,
  TAG_COLORS,
  TAG_ARCHETYPES,
  TAG_MECHANICS,
  TAG_TYPES,
  PRECOMPILED_ARCHETYPES,
  BEGINNER_DECKS,
  formatDeckForExport,
  resolveActiveGuidelines,
  calculateCompositeScore,
  updateTopShowcase,
  PerkCatalog,
  PERK_KEYS,
  RPBD_OPTIONS,
  getPerkDefinition,
  resolveRoll,
  matchRollToPerk,
  getLegalTargets,
  findLegalTargets,
  hasLegalTargets,
  executePerkEffect,
  RandomPerkEngine,
  executeAuthoritativeRoll,
  parseDecklist,
  REGEX_DECK_COMPREHENSIVE,
  REGEX_DECK_SIMPLE,
  ScryfallService,
  MemoryCacheAdapter,
  LocalStorageCacheAdapter,
  ZoneModel,
  classifySubzone,
  generateInstanceId,
  shuffleArray,
  resetCardState,
  StateTransitionError,
  CardNotFoundError,
  InvalidZoneError,
  InvalidCardTypeError,
  InsufficientManaError,
  PermanentAlreadyTappedError,
  PlayerNotFoundError,
  TabletopStateManager,
  projectState,
  PriorityStateMachine,
  PriorityViolationError,
  CheckpointJournal,
  PHASE_STEPS,
  generateStackItemId,
  generateCheckpointId,
  StackAlarmManager,
  DualChannelChat,
  PriorityGatedChatError,
  ProposalExpiredError,
  ActionLexer,
  ActionLexerError,
  generateProposalId,
  SpeechRecognitionService,
  TabletopUI,
  CardOverlayModal,
  formatManaSymbols,
  createRelayServer,
  generateRoomCode,
  WebSocketConnection,
  RoomSession,
  CROCKFORD_ALPHABET,
  timingSafeEqualString,
  RelayClient,
  EventEmitter,
  RPMAppController,
  AppController,
  PerkinsAgent,
  PERKINS_DEFAULT_CONFIG,
  PERKINS_COACH_DIALOGUES,
  DeckValidator,
  LobbyManager,
  MatchmakingQueue,
  TabRouter,
  TurnRollOffManager,
  AuthManager,
  STARTER_ARCHETYPES,
  STARTER_ALIASES,
  getStarterDeck,
  calculateAge,
  generateUUID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  AUTH_STORAGE_KEY,
  TELEMETRY_STORAGE_KEY,
  DiceCanvas,
  diceCanvas,
  is3DSupported,
  DiceShaker,
  diceShaker
};

