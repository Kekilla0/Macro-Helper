import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { addLight, removeLight, hasLight } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * Held Light (Equipment page, with Hands) : a torch, lantern, lamp or candle in a hand lights the character's token, by
 * item identifier (dnd5e's items have no light data). Off / Light only / Light and burn time (the default).
 *
 *   Burn time : a lit light is an effect on the character (Lit Torch...) lasting what's left of it on the game clock
 *               (2024 : torch and candle 1 hour, lanterns and lamp 6 hours on a flask of oil). Put down early, it keeps
 *               the time left for next time. Burnt out (the clock passes its end) : a torch or candle is used up (one
 *               of the stack; the last one, gone from the hand); a lantern or lamp stays in hand, dark, and lighting
 *               it again (taking it in hand again) uses a flask of Oil from the inventory. Deleting the effect puts
 *               the light out; the item stays in hand.
 */
export class heldLight{
  /* By item identifier : the token's light (bright / dim feet, a cone's angle) and how long it burns (hours) */
  static SOURCES = {
    "torch" : { hours : 1, used : true, light : { bright : 20, dim : 40, color : "#ff9b3d", alpha : 0.35, animation : { type : "torch", speed : 3, intensity : 3 } } },
    "candle" : { hours : 1, used : true, light : { bright : 5, dim : 10, color : "#ffb85c", alpha : 0.3, animation : { type : "torch", speed : 2, intensity : 2 } } },
    "lantern-hooded" : { hours : 6, oil : true, light : { bright : 30, dim : 60, color : "#ffb85c", alpha : 0.3 } },
    "hooded-lantern" : { hours : 6, oil : true, light : { bright : 30, dim : 60, color : "#ffb85c", alpha : 0.3 } },
    "lantern-bullseye" : { hours : 6, oil : true, light : { bright : 60, dim : 120, angle : 60, color : "#ffb85c", alpha : 0.3 } },
    "bullseye-lantern" : { hours : 6, oil : true, light : { bright : 60, dim : 120, angle : 60, color : "#ffb85c", alpha : 0.3 } },
    "lamp" : { hours : 6, oil : true, light : { bright : 15, dim : 45, color : "#ffb85c", alpha : 0.3 } },
  };
  static OIL = ["oil", "flask-of-oil", "oil-flask"];

  static mode(){
    return settings.value("handsLight") ?? "timed";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("updateActiveEffect", effect => this.onExpired(effect));
    Hooks.on("deleteActiveEffect", (effect, options, userId) => this.onEffectDeleted(effect, options, userId));
    /* A burning torch swung at someone isn't used up (its item's attack is set to spend a use it doesn't have) */
    Hooks.on("dnd5e.preUseActivity", (activity, usage) => {
      if((activity?.type === "attack") && this.sourceOf(activity.item)) usage.consume = false;
    });
  }

  static idOf(item){
    return item?.identifier ?? item?.system?.identifier ?? "";
  }

  static sourceOf(item){
    return this.SOURCES[this.idOf(item)] ?? null;
  }

  static key(id){
    return `hand-${id}`;
  }

  static effectOf(actor, id){
    return actor?.effects?.find?.(e => e.getFlag(module.id, "heldLight") === id) ?? null;
  }

  static isLit(actor, id){
    return hasLight(actor, this.key(id)) || !!this.effectOf(actor, id);
  }

  /**
   * The hands changed : what's let go goes out (keeping its time), what's newly held lights up.
   * @param {Actor} actor
   * @param {Set<string>} held   item ids now in hand
   * @param {Set<string>} was    item ids in hand before
   */
  static async sync(actor, held, was){
    if(this.mode() === "off") return;
    for(const id of was) if(!held.has(id) && this.isLit(actor, id)) await this.putOut(actor, id, { keepTime : true });
    for(const id of held){
      const item = actor.items.get(id);
      if(this.sourceOf(item) && !this.isLit(actor, id)) await this.lightUp(actor, item);
    }
  }

  /* Light it : the token's light, and (burn time) its effect for the time it has left; a dry lantern needs oil first */
  static async lightUp(actor, item){
    const source = this.sourceOf(item);
    if(!source) return false;
    const timed = this.mode() === "timed";
    let seconds = source.hours * 3600;
    if(timed){
      if(item.getFlag(module.id, "burnedOut")){
        if(!source.oil) return false;
        const oil = actor.items.find(i => this.OIL.includes(this.idOf(i)));
        if(!oil){
          ui.notifications.warn(module.format("hands.noOil", { item : item.name }));
          return false;
        }
        await this.useOne(oil);
        await item.unsetFlag(module.id, "burnedOut");
        await item.unsetFlag(module.id, "burnLeft");
      }
      const left = Number(item.getFlag(module.id, "burnLeft"));
      if(left > 0) seconds = left;
    }
    await addLight(actor, source.light, { key : this.key(item.id) });
    if(timed){
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name : module.format("hands.lit", { item : item.name }), img : item.img, origin : item.uuid, transfer : false,
        duration : { value : Math.max(1, Math.ceil(seconds)), units : "seconds", expiry : null }, start : { time : game.time.worldTime },
        showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
        flags : { [module.id] : { heldLight : item.id } },
      }]);
    }
    log.debug("Light", actor.name, item.name, timed ? `${seconds}s` : "");
    return true;
  }

  /* The time a lit light has left, from its effect */
  static secondsLeft(effect){
    const value = Number(effect?.duration?.value) || 0;
    const start = Number(effect?.start?.time ?? game.time.worldTime);
    return Math.max(0, (start + value) - game.time.worldTime);
  }

  /* Put it out : the light goes; keepTime : the time it had left is kept on the item for next time */
  static async putOut(actor, id, { keepTime = false } = {}){
    if(hasLight(actor, this.key(id))) await removeLight(actor, { key : this.key(id) });
    const effect = this.effectOf(actor, id);
    if(!effect) return;
    const item = actor.items.get(id);
    if(keepTime && item) await item.setFlag(module.id, "burnLeft", this.secondsLeft(effect));
    await effect.delete({ [module.id] : { heldLight : true } });
  }

  /* One of a stack used (quantity down, the last one deleted) */
  static async useOne(item){
    const quantity = Number(item.system?.quantity) || 1;
    if(quantity > 1) await item.update({ "system.quantity" : quantity - 1 });
    else await item.delete();
  }

  /* The clock passed its end (the active GM) : burnt out */
  static async onExpired(effect){
    if(!game.users.activeGM?.isSelf || !effect?.duration?.expired) return;
    const id = effect.getFlag?.(module.id, "heldLight");
    const actor = (effect.parent?.documentName === "Actor") ? effect.parent : null;
    if(!id || !actor) return;
    await this.burnOut(actor, id);
  }

  /* Burnt out : a torch or candle used up, a lantern or lamp dark until it gets oil; its owners are told */
  static async burnOut(actor, id){
    const item = actor.items.get(id);
    const source = this.sourceOf(item);
    await this.putOut(actor, id);
    if(!item || !source) return;
    await item.unsetFlag(module.id, "burnLeft");
    if(source.used) await this.useOne(item);
    else await item.setFlag(module.id, "burnedOut", true);
    const owners = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }), whisper : owners,
      content : `<p>${foundry.utils.escapeHTML(module.format(source.used ? "hands.burntOut" : "hands.outOfOil", { name : actor.name, item : item.name }))}</p>`,
    });
  }

  /* The effect deleted by hand : the light goes out, the time left is kept, the item stays in hand */
  static async onEffectDeleted(effect, options = {}, userId){
    if((userId !== game.user.id) || options[module.id]?.heldLight) return;
    const id = effect.getFlag?.(module.id, "heldLight");
    const actor = (effect.parent?.documentName === "Actor") ? effect.parent : null;
    if(!id || !actor) return;
    const item = actor.items.get(id);
    if(item) await item.setFlag(module.id, "burnLeft", this.secondsLeft(effect));
    if(hasLight(actor, this.key(id))) await removeLight(actor, { key : this.key(id) });
  }
}
