/**
 * src/view/DiceRenderer3D.js
 * 3D Dice Renderer Viewport Module ported from rpmrevival.
 * 
 * Re-exports DiceCanvas as DiceRenderer3D.
 * Specification: SPEC-RPM-DICE-018
 * @module DiceRenderer3D
 */

import { DiceCanvas, diceCanvas, is3DSupported, DICE_COLORS } from './DiceCanvas.js';

export {
  DiceCanvas,
  DiceCanvas as DiceRenderer3D,
  diceCanvas,
  is3DSupported,
  DICE_COLORS
};

export default DiceCanvas;
