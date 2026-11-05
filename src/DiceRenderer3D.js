/**
 * src/DiceRenderer3D.js
 * Headless-safe root re-export for DiceRenderer3D.
 * 
 * Enforces Architectural Invariants:
 * - INV-ARCH-HEADLESS: No unguarded browser globals
 * - INV-DICE-3D-1: 3D Dice Engine Integration
 * 
 * Specification: SPEC-RPM-DICE-018
 * @module DiceRenderer3D
 */

import { DiceCanvas, diceCanvas, is3DSupported, DICE_COLORS } from './view/DiceCanvas.js';

export {
  DiceCanvas,
  DiceCanvas as DiceRenderer3D,
  diceCanvas,
  is3DSupported,
  DICE_COLORS
};

export default DiceCanvas;
