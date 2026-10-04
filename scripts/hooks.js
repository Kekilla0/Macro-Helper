import { module } from './module.js';
import { settings } from './settings.js';
import { logger } from './log.js';
import { itemMacro } from './item-macro/item-macro.js';
import { api } from './api.js';
import { rollItem } from './roll-item/roll-item.js';
import { hookMacros } from './hook-macros/hook-macros.js';
import { methods } from './helpers/methods.js';
import { conditions } from './rules/conditions.js';
import { weapons } from './rules/weapons.js';
import { homebrew } from './rules/homebrew.js';
import { actions } from './rules/actions.js';
import { barbarian } from './rules/classes/barbarian.js';
import { bard } from './rules/classes/bard.js';
import { cleric } from './rules/classes/cleric.js';
import { druid } from './rules/classes/druid.js';
import { restChoices } from './rules/rest-choices.js';
import { familiars } from './rules/familiars.js';
import { gm } from './gm.js';
import { feats } from './rules/feats.js';
import { initiative } from './rules/initiative.js';
const log = logger.for(import.meta.url);

Hooks.once("init", ()=> {
  log.info("Initializing module.");
  settings.register();
  api.register();
  rollItem.register();
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
