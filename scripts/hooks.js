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
  gm.register();
  feats.register();
  initiative.register();
});

/* System classes and CONFIG are in place by setup */
Hooks.once("setup", ()=> {
  itemMacro.register();
  if(settings.value("helperMethods")) methods.register();
});

/* World macros exist from here on */
Hooks.once("ready", ()=> {
  log.info("Module ready.");
  log.debug("Module data", module.data);
  hookMacros.register();
});

/**
 * TODO
 *
 * COMPLETED
 *
 */
