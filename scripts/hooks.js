import { module } from './module.js';
import { settings } from './settings.js';
import { logger } from './log.js';
import { itemMacro } from './item-macro/item-macro.js';
import { api } from './api.js';
import { rollItem } from './roll-item/roll-item.js';
const log = logger.for(import.meta.url);

Hooks.once("init", ()=> {
  log.info("Initializing module.");
  settings.register();
  api.register();
  rollItem.register();
});

/* System classes and CONFIG are in place by setup */
Hooks.once("setup", ()=> {
  itemMacro.register();
});

Hooks.once("ready", ()=> {
  log.info("Module ready.");
  log.debug("Module data", module.data);
});

/**
 * TODO
 *
 * COMPLETED
 *
 */
