/**
 * RPM Multiplayer - Random Perk Catalog & Effect Handlers
 * Pure data definitions, localization, target predicates, and effect mutations.
 * 
 * Specification: SPEC-RPM-PERK-009
 * @module PerkCatalog
 */

export const PERK_KEYS = Object.freeze([
  '00', '11', '22', '33', '44',
  '55', '66', '77', '88', '99',
  '13', 'RPBD'
]);

export const RPBD_OPTIONS = Object.freeze([
  {
    id: 'RPBD_ATTACK_FORCE',
    modeNumber: 1,
    name: 'Attack Force',
    en: "Until your next turn, each creature your opponents control must attack if able. They can't attack you.",
    es: "Hasta tu próximo turno, cada criatura que controlan tus oponentes debe atacar si puede. No pueden atacarte a ti.",
    execute: (state, { activePlayerId }) => {
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      if (player) {
        player.resources = player.resources || {};
        player.resources.mustAttackOthersUntilNextTurn = true;
      }
      return {
        success: true,
        mutationsApplied: { customEffects: ['ATTACK_OTHERS_IF_ABLE'] },
        logSummary: "Opponents' creatures must attack others if able until next turn"
      };
    }
  },
  {
    id: 'RPBD_FREE_SPELLS',
    modeNumber: 2,
    name: 'Free Spells',
    en: "Draw 3 cards, reveal them. You may cast the revealed spells this way without paying their mana costs.",
    es: "Roba 3 cartas, revélalas. Puedes lanzar los hechizos revelados de esta manera sin pagar su coste de maná.",
    execute: (state, { activePlayerId }) => {
      const drawResult = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 3 });
      state.dispatch('REVEAL_HAND', { playerId: activePlayerId });
      return {
        success: true,
        mutationsApplied: {
          cardsDrawn: { [activePlayerId]: drawResult.drawnCount },
          customEffects: ['FREE_SPELLS_PERMITTED']
        },
        logSummary: `Drew ${drawResult.drawnCount} cards, revealed hand for free casting`
      };
    }
  },
  {
    id: 'RPBD_DISCARD_NONLAND',
    modeNumber: 3,
    name: 'Discard Nonland',
    en: "Each opponent reveals their hand. For each one, choose a nonland card from their hand, each opponent discards that card. Draw 1 card.",
    es: "Cada oponente revela su mano. Por cada uno elige una carta de su mano que no sea tierra, cada oponente se descarta esa carta. Roba 1 carta.",
    execute: (state, { activePlayerId }) => {
      const discards = {};
      const players = state.players || {};
      for (const [pId, player] of Object.entries(players)) {
        if (pId !== activePlayerId && !player.isEliminated) {
          state.dispatch('REVEAL_HAND', { playerId: pId });
          const nonlandIdx = (player.hand || []).findIndex(c => !/land/i.test(c.typeLine || ''));
          if (nonlandIdx !== -1) {
            const card = player.hand[nonlandIdx];
            state.dispatch('MOVE_ZONE', { playerId: pId, instanceId: card.instanceId, targetZone: 'graveyard' });
            discards[pId] = 1;
          }
        }
      }
      const drawResult = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 1 });
      return {
        success: true,
        mutationsApplied: {
          cardsDiscarded: discards,
          cardsDrawn: { [activePlayerId]: drawResult.drawnCount }
        },
        logSummary: `Each opponent discarded a nonland card; active player drew ${drawResult.drawnCount} card`
      };
    }
  },
  {
    id: 'RPBD_LIFE_LEECH',
    modeNumber: 4,
    name: 'Life Leech',
    en: "Each opponent loses 3 life, you gain life equal to the amount of life lost this turn.",
    es: "Cada oponente pierde 3 vidas, ganas vida igual a la cantidad de vidas perdidas este turno.",
    execute: (state, { activePlayerId }) => {
      let totalLost = 0;
      const lifeDeltas = {};
      const players = state.players || {};
      for (const [pId, player] of Object.entries(players)) {
        if (pId !== activePlayerId && !player.isEliminated) {
          state.dispatch('ADJUST_LIFE', { playerId: pId, delta: -3 });
          lifeDeltas[pId] = -3;
          totalLost += 3;
        }
      }
      state.dispatch('ADJUST_LIFE', { playerId: activePlayerId, delta: totalLost });
      lifeDeltas[activePlayerId] = totalLost;
      return {
        success: true,
        mutationsApplied: { lifeDeltas },
        logSummary: `Opponents lost 3 life each; active player gained ${totalLost} life`
      };
    }
  },
  {
    id: 'RPBD_ATTACK_DRAW',
    modeNumber: 5,
    name: 'Attack Draw',
    en: "Until end of turn, your creatures gain 'Whenever this creature attacks, you may draw a card.'",
    es: "Hasta el final de tu turno, tus criaturas ganan 'Siempre que esta criatura ataque, puedes robar una carta.'",
    execute: (state, { activePlayerId }) => {
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      if (player) {
        player.resources = player.resources || {};
        player.resources.attackDrawUntilEOT = true;
      }
      return {
        success: true,
        mutationsApplied: { customEffects: ['CREATURES_ATTACK_DRAW_GRANTED'] },
        logSummary: "Active player's creatures gain attack-draw until end of turn"
      };
    }
  }
]);

const CANONICAL_PERKS = Object.freeze({
  '00': {
    key: '00',
    name: 'Genesis Surge',
    names: { en: 'Genesis Surge', es: 'Oleada de Génesis' },
    rulesText: {
      en: 'You gain 10 life and draw three cards.',
      es: 'Ganas 10 vidas.\nRoba tres cartas.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      state.dispatch('ADJUST_LIFE', { playerId: activePlayerId, delta: 10 });
      const drawRes = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 3 });
      return {
        success: true,
        perkKey: '00',
        activePlayerId,
        mutationsApplied: {
          lifeDeltas: { [activePlayerId]: 10 },
          cardsDrawn: { [activePlayerId]: drawRes.drawnCount }
        },
        logSummary: `Player ${activePlayerId} gained 10 life and drew ${drawRes.drawnCount} cards`
      };
    }
  },

  '11': {
    key: '11',
    name: 'Overrun Counter',
    names: { en: 'Overrun Counter', es: 'Contador de Arrollar' },
    rulesText: {
      en: 'Put a +1/+1 on each creature you control.',
      es: 'Pon un contador +1/+1 sobre cada criatura que controlas.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      const creatures = player?.battlefield?.creatures || [];
      const countersAdded = [];
      for (const creature of creatures) {
        state.dispatch('MODIFY_COUNTERS', {
          playerId: activePlayerId,
          instanceId: creature.instanceId,
          counterType: '+1/+1',
          delta: 1
        });
        countersAdded.push({ instanceId: creature.instanceId, counterType: '+1/+1', amount: 1 });
      }
      return {
        success: true,
        perkKey: '11',
        activePlayerId,
        mutationsApplied: { countersAdded },
        logSummary: `Put a +1/+1 counter on ${countersAdded.length} creature(s)`
      };
    }
  },

  '22': {
    key: '22',
    name: 'Divination',
    names: { en: 'Divination', es: 'Adivinación' },
    rulesText: {
      en: 'Draw two cards.',
      es: 'Roba dos cartas.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const drawRes = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 2 });
      return {
        success: true,
        perkKey: '22',
        activePlayerId,
        mutationsApplied: {
          cardsDrawn: { [activePlayerId]: drawRes.drawnCount }
        },
        logSummary: `Player ${activePlayerId} drew ${drawRes.drawnCount} card(s)`
      };
    }
  },

  '33': {
    key: '33',
    name: 'Vitality Boost',
    names: { en: 'Vitality Boost', es: 'Aumento de Vitalidad' },
    rulesText: {
      en: 'You gain 10 life.',
      es: 'Ganas 10 vidas.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      state.dispatch('ADJUST_LIFE', { playerId: activePlayerId, delta: 10 });
      return {
        success: true,
        perkKey: '33',
        activePlayerId,
        mutationsApplied: {
          lifeDeltas: { [activePlayerId]: 10 }
        },
        logSummary: `Player ${activePlayerId} gained 10 life`
      };
    }
  },

  '44': {
    key: '44',
    name: 'Exploration',
    names: { en: 'Exploration', es: 'Exploración' },
    rulesText: {
      en: 'Draw a card. You may play an additional land from your hand this turn.',
      es: 'Roba una carta.\nPuedes poner en juego una tierra adicional este turno.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const drawRes = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 1 });
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      if (player) {
        player.resources = player.resources || {};
        player.resources.additionalLandsAllowed = (player.resources.additionalLandsAllowed || 0) + 1;
      }
      return {
        success: true,
        perkKey: '44',
        activePlayerId,
        mutationsApplied: {
          cardsDrawn: { [activePlayerId]: drawRes.drawnCount },
          additionalLandsAllowed: 1
        },
        logSummary: `Player ${activePlayerId} drew ${drawRes.drawnCount} card and gained 1 additional land play`
      };
    }
  },

  '55': {
    key: '55',
    name: 'Cataclysmic Ruin',
    names: { en: 'Cataclysmic Ruin', es: 'Ruina Cataclísmica' },
    rulesText: {
      en: 'All permanents lose hexproof and indestructible until end of turn. Destroy target permanent.',
      es: 'Todos los permanentes pierden las habilidades de antimaleficio e indestructible. \nDestruye el permanente objetivo.'
    },
    isTargeted: true,
    targetType: 'PERMANENT',
    requiresTargets: true,
    getLegalTargets: (state) => {
      const targets = [];
      const players = state?.players || {};
      for (const [pId, player] of Object.entries(players)) {
        if (player.isEliminated) continue;
        const bf = player.battlefield || {};
        for (const subzone of ['lands', 'creatures', 'noncreatures', 'planeswalkers']) {
          for (const card of (bf[subzone] || [])) {
            targets.push({
              targetType: 'PERMANENT',
              targetId: card.instanceId,
              ownerId: pId,
              card
            });
          }
        }
      }
      return targets;
    },
    hasLegalTargets: (state) => {
      const targets = CANONICAL_PERKS['55'].getLegalTargets(state);
      return targets.length > 0;
    },
    execute: (state, { activePlayerId, targets = [] }) => {
      // 1. Strip hexproof & indestructible until EOT
      const players = state.players || {};
      for (const player of Object.values(players)) {
        const bf = player.battlefield || {};
        for (const subzone of ['lands', 'creatures', 'noncreatures', 'planeswalkers']) {
          for (const card of (bf[subzone] || [])) {
            card.strippedProtectionUntilEOT = true;
            card.hexproof = false;
            card.indestructible = false;
          }
        }
      }

      // 2. Destroy target permanent
      const rawTarget = targets[0];
      const targetId = rawTarget?.targetId || rawTarget?.instanceId || (typeof rawTarget === 'string' ? rawTarget : null);
      let targetOwnerId = rawTarget?.ownerId;

      if (targetId && !targetOwnerId) {
        // Search across players for the card
        for (const [pId, player] of Object.entries(players)) {
          const bf = player.battlefield || {};
          for (const subzone of ['lands', 'creatures', 'noncreatures', 'planeswalkers']) {
            if ((bf[subzone] || []).some(c => c.instanceId === targetId)) {
              targetOwnerId = pId;
              break;
            }
          }
          if (targetOwnerId) break;
        }
      }

      const destroyed = [];
      if (targetId && targetOwnerId) {
        try {
          state.dispatch('MOVE_ZONE', {
            playerId: targetOwnerId,
            instanceId: targetId,
            targetZone: 'graveyard'
          });
          destroyed.push(targetId);
        } catch (err) {
          // If target is no longer on battlefield or illegal on resolution, fizzle target part
          console.warn(`Perk #55 could not destroy permanent ${targetId}:`, err?.message);
        }
      }

      return {
        success: true,
        perkKey: '55',
        activePlayerId,
        mutationsApplied: {
          permanentsDestroyed: destroyed,
          customEffects: ['ALL_PERMANENTS_STRIPPED_PROTECTION_UNTIL_EOT']
        },
        logSummary: destroyed.length > 0
          ? `All permanents stripped of protection; destroyed permanent ${targetId}`
          : 'All permanents stripped of protection; target fizzled or was absent'
      };
    }
  },

  '66': {
    key: '66',
    name: 'Mutual Sacrifice',
    names: { en: 'Mutual Sacrifice', es: 'Sacrificio Mutuo' },
    rulesText: {
      en: 'Each player sacrifices a creature they control and discards a card.',
      es: 'Cada jugador sacrifica una criatura y descarta una carta.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const sacrificed = [];
      const discarded = {};
      const players = state.players || {};

      for (const [pId, player] of Object.entries(players)) {
        if (player.isEliminated) continue;

        // CR 608.2c Partial Execution: Sacrifice 1 creature if controlled
        const creatures = player.battlefield?.creatures || [];
        if (creatures.length > 0) {
          const toSacrifice = creatures[0];
          state.dispatch('MOVE_ZONE', {
            playerId: pId,
            instanceId: toSacrifice.instanceId,
            targetZone: 'graveyard'
          });
          sacrificed.push(toSacrifice.instanceId);
        }

        // CR 608.2c Partial Execution: Discard 1 card if in hand
        const hand = player.hand || [];
        if (hand.length > 0) {
          const toDiscard = hand[0];
          state.dispatch('MOVE_ZONE', {
            playerId: pId,
            instanceId: toDiscard.instanceId,
            targetZone: 'graveyard'
          });
          discarded[pId] = 1;
        }
      }

      return {
        success: true,
        perkKey: '66',
        activePlayerId,
        mutationsApplied: {
          permanentsSacrificed: sacrificed,
          cardsDiscarded: discarded
        },
        logSummary: `Each player sacrificed a creature (${sacrificed.length} total) and discarded a card`
      };
    }
  },

  '77': {
    key: '77',
    name: 'Precognition',
    names: { en: 'Precognition', es: 'Precognición' },
    rulesText: {
      en: 'Scry 2. Draw a card.',
      es: 'Adivina 2. \nRoba una carta.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      const libraryCount = player?.library?.length || 0;
      const scryCount = Math.min(2, libraryCount);
      const drawRes = state.dispatch('DRAW_CARD', { playerId: activePlayerId, count: 1 });
      return {
        success: true,
        perkKey: '77',
        activePlayerId,
        mutationsApplied: {
          scryPerformed: { playerId: activePlayerId, count: scryCount },
          cardsDrawn: { [activePlayerId]: drawRes.drawnCount }
        },
        logSummary: `Player ${activePlayerId} scried ${scryCount} card(s) and drew ${drawRes.drawnCount} card(s)`
      };
    }
  },

  '88': {
    key: '88',
    name: 'Peace Accord',
    names: { en: 'Peace Accord', es: 'Acuerdo de Paz' },
    rulesText: {
      en: 'Each player draws two cards and gains 2 life.',
      es: 'Cada jugador roba dos cartas y gana 2 vidas.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const lifeDeltas = {};
      const cardsDrawn = {};
      const players = state.players || {};

      for (const [pId, player] of Object.entries(players)) {
        if (player.isEliminated) continue;
        state.dispatch('ADJUST_LIFE', { playerId: pId, delta: 2 });
        lifeDeltas[pId] = 2;
        const drawRes = state.dispatch('DRAW_CARD', { playerId: pId, count: 2 });
        cardsDrawn[pId] = drawRes.drawnCount;
      }

      return {
        success: true,
        perkKey: '88',
        activePlayerId,
        mutationsApplied: { lifeDeltas, cardsDrawn },
        logSummary: 'Each living player drew 2 cards and gained 2 life'
      };
    }
  },

  '99': {
    key: '99',
    name: 'Torment',
    names: { en: 'Torment', es: 'Tormento' },
    rulesText: {
      en: 'Target player discards a card and sacrifices a permanent.',
      es: 'El jugador objetivo descarta y sacrifica un permanente.'
    },
    isTargeted: true,
    targetType: 'PLAYER',
    requiresTargets: true,
    getLegalTargets: (state, activePlayerId) => {
      const targets = [];
      const players = state?.players || {};
      for (const [pId, player] of Object.entries(players)) {
        if (pId !== activePlayerId && !player.isEliminated) {
          targets.push({
            targetType: 'PLAYER',
            targetId: pId,
            playerName: player.playerName || pId
          });
        }
      }
      return targets;
    },
    hasLegalTargets: (state, activePlayerId) => {
      const targets = CANONICAL_PERKS['99'].getLegalTargets(state, activePlayerId);
      return targets.length > 0;
    },
    execute: (state, { activePlayerId, targets = [] }) => {
      const rawTarget = targets[0];
      const targetPlayerId = rawTarget?.targetId || (typeof rawTarget === 'string' ? rawTarget : null);

      if (!targetPlayerId || !state.players?.[targetPlayerId]) {
        return {
          success: false,
          perkKey: '99',
          activePlayerId,
          mutationsApplied: {},
          logSummary: 'Perk #99 fizzled: no legal target player specified'
        };
      }

      const targetPlayer = state.players[targetPlayerId];
      const discarded = {};
      const sacrificed = [];

      // CR 608.2c Partial Execution: Discard 1 card if hand > 0
      if ((targetPlayer.hand || []).length > 0) {
        const toDiscard = targetPlayer.hand[0];
        state.dispatch('MOVE_ZONE', {
          playerId: targetPlayerId,
          instanceId: toDiscard.instanceId,
          targetZone: 'graveyard'
        });
        discarded[targetPlayerId] = 1;
      }

      // CR 608.2c Partial Execution: Sacrifice 1 permanent if permanent exists
      const bf = targetPlayer.battlefield || {};
      let permanentToSac = null;
      for (const subzone of ['creatures', 'noncreatures', 'lands', 'planeswalkers']) {
        if ((bf[subzone] || []).length > 0) {
          permanentToSac = bf[subzone][0];
          break;
        }
      }

      if (permanentToSac) {
        state.dispatch('MOVE_ZONE', {
          playerId: targetPlayerId,
          instanceId: permanentToSac.instanceId,
          targetZone: 'graveyard'
        });
        sacrificed.push(permanentToSac.instanceId);
      }

      return {
        success: true,
        perkKey: '99',
        activePlayerId,
        mutationsApplied: {
          cardsDiscarded: discarded,
          permanentsSacrificed: sacrificed
        },
        logSummary: `Target player ${targetPlayerId} discarded ${Object.keys(discarded).length} card(s) and sacrificed ${sacrificed.length} permanent(s)`
      };
    }
  },

  '13': {
    key: '13',
    name: 'Dark Misfortune',
    names: { en: 'Dark Misfortune', es: 'Infortunio Oscuro' },
    rulesText: {
      en: 'Discard a card and sacrifice a creature.',
      es: 'Descarta una carta y sacrifica una criatura.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, { activePlayerId }) => {
      const player = state.getPlayer ? state.getPlayer(activePlayerId) : state.players?.[activePlayerId];
      const discarded = {};
      const sacrificed = [];

      // CR 608.2c Partial Execution: Discard 1 card if hand size > 0
      if (player && (player.hand || []).length > 0) {
        const toDiscard = player.hand[0];
        state.dispatch('MOVE_ZONE', {
          playerId: activePlayerId,
          instanceId: toDiscard.instanceId,
          targetZone: 'graveyard'
        });
        discarded[activePlayerId] = 1;
      }

      // CR 608.2c Partial Execution: Sacrifice 1 creature if creature count > 0
      if (player && (player.battlefield?.creatures || []).length > 0) {
        const toSacrifice = player.battlefield.creatures[0];
        state.dispatch('MOVE_ZONE', {
          playerId: activePlayerId,
          instanceId: toSacrifice.instanceId,
          targetZone: 'graveyard'
        });
        sacrificed.push(toSacrifice.instanceId);
      }

      return {
        success: true,
        perkKey: '13',
        activePlayerId,
        mutationsApplied: {
          cardsDiscarded: discarded,
          permanentsSacrificed: sacrificed
        },
        logSummary: `Active player ${activePlayerId} discarded ${Object.keys(discarded).length} card(s) and sacrificed ${sacrificed.length} creature(s)`
      };
    }
  },

  'RPBD': {
    key: 'RPBD',
    name: 'Birthday Match',
    names: { en: 'Birthday Match', es: 'Coincidencia de Cumpleaños' },
    rulesText: {
      en: 'Birthday Match (RPBD). Choose 1 of 5 Birthday Burst modes.',
      es: 'Coincidencia de Cumpleaños (RPBD). Elige 1 de 5 modos.'
    },
    isTargeted: false,
    requiresTargets: false,
    getLegalTargets: () => [],
    hasLegalTargets: () => true,
    execute: (state, context) => {
      const { activePlayerId, birthdayOptionIndex } = context;
      let option = RPBD_OPTIONS[0];

      if (birthdayOptionIndex !== undefined) {
        if (typeof birthdayOptionIndex === 'string') {
          const found = RPBD_OPTIONS.find(o => o.id === birthdayOptionIndex);
          if (found) option = found;
        } else if (typeof birthdayOptionIndex === 'number') {
          // Check 1-based mode number (e.g. Mode 4 -> RPBD_LIFE_LEECH)
          const foundByMode = RPBD_OPTIONS.find(o => o.modeNumber === birthdayOptionIndex);
          if (foundByMode) {
            option = foundByMode;
          } else if (RPBD_OPTIONS[birthdayOptionIndex]) {
            option = RPBD_OPTIONS[birthdayOptionIndex];
          }
        }
      }

      const res = option.execute(state, { activePlayerId });
      return {
        success: true,
        perkKey: 'RPBD',
        activePlayerId,
        selectedOptionId: option.id,
        mutationsApplied: res.mutationsApplied || {},
        logSummary: `Birthday Match (RPBD) [${option.name}]: ${res.logSummary}`
      };
    }
  }
});

/**
 * Returns the immutable perk definition object for a given key and optional language.
 * @param {string} perkKey
 * @param {'en'|'es'} [lang='en']
 * @returns {Object|null}
 */
export function getPerkDefinition(perkKey, lang = 'en') {
  const perk = CANONICAL_PERKS[perkKey];
  if (!perk) return null;
  return {
    ...perk,
    name: perk.names?.[lang] || perk.name,
    text: perk.rulesText?.[lang] || perk.rulesText.en
  };
}

/**
 * Identifies whether a roll matches a perk key or a player's birthday roll.
 * @param {number|string} tensOrRollString
 * @param {number|string} [onesOrBirthdayRoll]
 * @param {string} [birthdayRollArg='69']
 * @returns {{ perkKey: string|null, matchedKey: string|null, tens: number, ones: number, rollString: string, isBirthday: boolean, isMiss: boolean }}
 */
export function resolveRoll(tensOrRollString, onesOrBirthdayRoll, birthdayRollArg = '69') {
  let tens, ones, rollString, birthdayRoll;

  if (typeof tensOrRollString === 'string' && tensOrRollString.length >= 2 && onesOrBirthdayRoll === undefined) {
    rollString = tensOrRollString.padStart(2, '0').slice(-2);
    tens = parseInt(rollString[0], 10);
    ones = parseInt(rollString[1], 10);
    birthdayRoll = '69';
  } else if (typeof tensOrRollString === 'string' && tensOrRollString.length >= 2 && typeof onesOrBirthdayRoll === 'string') {
    rollString = tensOrRollString.padStart(2, '0').slice(-2);
    tens = parseInt(rollString[0], 10);
    ones = parseInt(rollString[1], 10);
    birthdayRoll = onesOrBirthdayRoll;
  } else {
    tens = Number(tensOrRollString) || 0;
    ones = Number(onesOrBirthdayRoll) || 0;
    rollString = `${tens}${ones}`;
    birthdayRoll = String(birthdayRollArg || '69');
  }

  const normalizedBirthday = birthdayRoll.padStart(2, '0').slice(-2);

  // Check Birthday Match first (DEC-014)
  if (rollString === normalizedBirthday) {
    return {
      perkKey: 'RPBD',
      matchedKey: 'RPBD',
      tens,
      ones,
      rollString,
      isBirthday: true,
      isMiss: false
    };
  }

  // Canonical double perk keys + "13"
  const canonicalDoubles = ['00', '11', '22', '33', '44', '55', '66', '77', '88', '99', '13'];
  if (canonicalDoubles.includes(rollString)) {
    return {
      perkKey: rollString,
      matchedKey: rollString,
      tens,
      ones,
      rollString,
      isBirthday: false,
      isMiss: false
    };
  }

  // Miss
  return {
    perkKey: null,
    matchedKey: null,
    tens,
    ones,
    rollString,
    isBirthday: false,
    isMiss: true
  };
}

/**
 * Alias conforming to SPEC-RPM-PERK-009 Section 9.1
 */
export function matchRollToPerk(rollString, playerBirthdayRoll = '69') {
  return resolveRoll(rollString, playerBirthdayRoll);
}

/**
 * Discovers legal targets for a perk in the tabletop state.
 * Supports both (perkKey, stateManager, activePlayerId) and (perkKey, activePlayerId, stateManager).
 * 
 * @param {string} perkKey
 * @param {Object|string} stateManagerOrPlayerId
 * @param {string|Object} activePlayerIdOrStateManager
 * @returns {Array<Object>}
 */
export function getLegalTargets(perkKey, stateManagerOrPlayerId, activePlayerIdOrStateManager) {
  let stateManager, activePlayerId;
  if (typeof stateManagerOrPlayerId === 'object') {
    stateManager = stateManagerOrPlayerId;
    activePlayerId = String(activePlayerIdOrStateManager || '');
  } else {
    activePlayerId = String(stateManagerOrPlayerId || '');
    stateManager = activePlayerIdOrStateManager;
  }

  const perk = CANONICAL_PERKS[perkKey];
  if (!perk || !perk.getLegalTargets) return [];
  return perk.getLegalTargets(stateManager, activePlayerId);
}

/**
 * Alias for getLegalTargets
 */
export function findLegalTargets(perkKey, activePlayerId, tabletopState) {
  return getLegalTargets(perkKey, tabletopState, activePlayerId);
}

/**
 * Returns true if the perk has legal targets or does not require targets (CR 603.3d).
 * 
 * @param {string} perkKey
 * @param {Object|string} stateManagerOrPlayerId
 * @param {string|Object} activePlayerIdOrStateManager
 * @returns {boolean}
 */
export function hasLegalTargets(perkKey, stateManagerOrPlayerId, activePlayerIdOrStateManager) {
  let stateManager, activePlayerId;
  if (typeof stateManagerOrPlayerId === 'object') {
    stateManager = stateManagerOrPlayerId;
    activePlayerId = String(activePlayerIdOrStateManager || '');
  } else {
    activePlayerId = String(stateManagerOrPlayerId || '');
    stateManager = activePlayerIdOrStateManager;
  }

  const perk = CANONICAL_PERKS[perkKey];
  if (!perk) return false;
  if (!perk.requiresTargets) return true;
  return perk.hasLegalTargets(stateManager, activePlayerId);
}

/**
 * Executes a perk effect mutation under MTG CR 608.2c.
 * Supports both signatures:
 * - executePerkEffect(perkKey, stateManager, context)
 * - executePerkEffect(perkKey, activePlayerId, targets, tabletopState, options)
 * 
 * @param {string} perkKey
 * @param {any} arg2
 * @param {any} [arg3]
 * @param {any} [arg4]
 * @param {any} [arg5]
 * @returns {Object} PerkExecutionResult
 */
export function executePerkEffect(perkKey, arg2, arg3, arg4, arg5) {
  let stateManager, activePlayerId, targets, birthdayOptionIndex, metadata;

  if (arg2 && typeof arg2 === 'object' && (arg2.players || arg2.dispatch)) {
    // executePerkEffect(perkKey, stateManager, context)
    stateManager = arg2;
    const context = arg3 || {};
    activePlayerId = context.activePlayerId;
    targets = context.targets;
    birthdayOptionIndex = context.birthdayOptionIndex ?? context.birthdayMode ?? context.birthdayOptionId;
    metadata = context.metadata;
  } else {
    // executePerkEffect(perkKey, activePlayerId, targets, tabletopState, options)
    activePlayerId = arg2;
    targets = arg3;
    stateManager = arg4;
    const options = arg5 || {};
    birthdayOptionIndex = options.birthdayOptionIndex ?? options.birthdayMode ?? options.birthdayOptionId;
    metadata = options.metadata;
  }

  const perk = CANONICAL_PERKS[perkKey];
  if (!perk) {
    throw new Error(`Unknown perk key: ${perkKey}`);
  }

  return perk.execute(stateManager, {
    activePlayerId,
    targets,
    birthdayOptionIndex,
    metadata
  });
}

export const PerkCatalog = {
  PERK_KEYS,
  RPBD_OPTIONS,
  getPerkDefinition,
  resolveRoll,
  matchRollToPerk,
  getLegalTargets,
  findLegalTargets,
  hasLegalTargets,
  executePerkEffect
};

export default PerkCatalog;
