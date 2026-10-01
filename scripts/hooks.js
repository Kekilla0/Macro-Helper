import { module } from './module.js';
import { settings } from './settings.js';
import { logger } from './log.js';
import { itemMacro } from './item-macro/item-macro.js';
import { api } from './api.js';
import { rollItem } from './roll-item/roll-item.js';
import { hookMacros } from './hook-macros/hook-macros.js';
import { methods } from './helpers/methods.js';
import { conditions } from './conditions.js';
import { gm } from './gm.js';
const log = logger.for(import.meta.url);

Hooks.once("init", ()=> {
  log.info("Initializing module.");
  settings.register();
  api.register();
  rollItem.register();
  conditions.register();
  gm.register();
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
