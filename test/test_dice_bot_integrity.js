/**
 * test/test_dice_bot_integrity.js
 * Alias redirect for Feature 18 acceptance test suite
 */

import { runTestSuite } from './test_3d_dice_and_integrity.js';

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
