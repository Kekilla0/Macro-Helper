/* Organizational Tools */
import { module, logger } from './apps/module.js';

/* Sub Modules */
import { token } from './modules/token.js';
import { actor } from './modules/actor.js';
import { item } from './modules/item.js';
import { activeeffect } from './modules/activeeffect.js';
import { compendium } from './modules/compendium.js';
import { array } from './modules/array.js';
import { table } from './modules/table.js';

const SUB_MODULES = {
  module, logger, token, actor, item, activeeffect, compendium, array, table,
}

/* Initialize Module */
Hooks.on(`ready`, () => {
  module.build();

  Object.values(SUB_MODULES).forEach(cl => cl.register());

  //global testing
  Object.entries(SUB_MODULES).forEach(([key, cl])=> window[key] = cl);
})

