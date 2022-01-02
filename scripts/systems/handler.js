import { module, logger, dcl } from '../apps/module.js';

/* Systems */
import * as dnd5e from './dnd5e.js';

const NAME = "handler";
const SYSTEMS = { dnd5e };

export class handler extends dcl{
  static execute(type){
    let cl = SYSTEMS?.[game.system.id]?.[type];

    if(!cl) return;

    cl.settings();
    cl.hooks();
    cl.patch();
    cl.globals();
  }
}