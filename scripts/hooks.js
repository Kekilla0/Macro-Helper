import { module } from './module.js';
import { settings } from './settings.js';
import { logger } from './log.js';
import { itemMacro } from './item-macro/item-macro.js';
import { api } from './api.js';
import { rollItem } from './roll-item/roll-item.js';
import { hookMacros } from './hook-macros/hook-macros.js';
import { methods } from './helpers/methods.js';
import { conditions } from './automation/conditions.js';
import { weapons } from './automation/weapons.js';
import { homebrew } from './automation/homebrew.js';
import { actions } from './automation/actions.js';
import { barbarian } from './automation/classes/barbarian.js';
import { bard } from './automation/classes/bard.js';
import { cleric } from './automation/classes/cleric.js';
import { druid } from './automation/classes/druid.js';
import { restChoices } from './automation/rest-choices.js';
import { familiars } from './automation/familiars.js';
import { fighter } from './automation/classes/fighter.js';
import { monk } from './automation/classes/monk.js';
import { paladin } from './automation/classes/paladin.js';
import { ranger } from './automation/classes/ranger.js';
import { rogue } from './automation/classes/rogue.js';
import { sorcerer } from './automation/classes/sorcerer.js';
import { warlock } from './automation/classes/warlock.js';
import { wizard } from './automation/classes/wizard.js';
import { preparedSpells } from './automation/prepared-spells.js';
import { weaponMastery } from './automation/weapon-mastery.js';
import { fightingStyles } from './automation/fighting-styles.js';
import { compendiums } from './automation/compendiums.js';
import { limits } from './automation/limits.js';
import { rollRequests } from './requests/requests.js';
import { hands } from './automation/hands.js';
import { heldLight } from './automation/held-light.js';
import { ammunition } from './automation/ammunition.js';
import { gm } from './gm.js';
import { feats } from './automation/feats.js';
import { initiative } from './automation/initiative.js';
import { uses } from './uses.js';
import { itemFixes } from './automation/item-fixes.js';
import { rollModes } from './automation/roll-modes.js';
import { masteries } from './automation/masteries.js';
import { maneuvers } from './automation/maneuvers.js';
import { spells } from './automation/spells.js';
import { repeating } from './automation/repeating.js';
import { dancingLights } from './automation/dancing-lights.js';
const log = logger.for(import.meta.url);

Hooks.once("init", ()=> {
  log.info("Initializing module.");
  settings.register();
  uses.register();
  itemFixes.register();
  rollModes.register();
  api.register();
  rollItem.register();
  masteries.register();
  maneuvers.register();
  conditions.register();
  weapons.register();
  homebrew.register();
  actions.register();
  barbarian.register();
  bard.register();
  cleric.register();
  druid.register();
  restChoices.register();
  familiars.register();
  fighter.register();
  monk.register();
  paladin.register();
  ranger.register();
  rogue.register();
  sorcerer.register();
  warlock.register();
  wizard.register();
  preparedSpells.register();
  spells.register();
  repeating.register();
  dancingLights.register();
  weaponMastery.register();
  fightingStyles.register();
  compendiums.register();
  limits.register();
  rollRequests.register();
  hands.register();
  heldLight.register();
  ammunition.register();
  gm.register();
  feats.register();
  initiative.register();
});

/* System classes and CONFIG are in place by setup */
Hooks.once("setup", ()=> {
  itemMacro.register();
  methods.register();
});

/* World macros exist from here on */
Hooks.once("ready", ()=> {
  log.info("Module ready.");
  log.debug("Module data", module.data);
  hookMacros.register();
  settings.migrate();
});

/**
 * TODO
 *
 * COMPLETED
 *
 */
