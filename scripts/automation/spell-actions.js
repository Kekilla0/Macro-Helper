import { module } from '../module.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { gm } from '../gm.js';
import { spells } from './spells.js';
import { hands } from './hands.js';
import { actions } from './actions.js';
import { TYPES } from '../roll-item/message.js';
import { idOf, chooseOption, buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { stabilize } from '../helpers/actors.js';
import { pickTargets, pickSpace } from '../helpers/targets.js';
import { tokenOf, getRange, pullToward, addLight, removeLight } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * What spells do beyond their roll (System Automation → Spells switch). Building blocks, each by spell identifier :
 *
 *   Pull          : a hit pulls the creature straight toward the caster (Thorn Whip, 10 ft, Large or smaller) : the
 *                   GM's button on the attack card, stopping at walls and creatures.
 *   By health     : a spell with one activity for a healthy target and one for a hurt one (Toll the Dead) uses the
 *                   right one for its target (no question).
 *   Stabilize     : Spare the Dying picks a creature at 0 HP in range first (none : nothing cast), then it's Stable
 *                   (Help's Stabilize : someone else's creature, the GM's button).
 *   Enchant       : a spell that enchants an item (True Strike, Shillelagh) asks which of yours, from the eligible
 *                   ones (what's in your hands first), and enchants it. True Strike then attacks with it.
 *   Light         : Light : on a creature or object (a token in reach) or on a square in reach; Produce Flame : in
 *                   your hand (your token). A real light, for its duration (an effect on the caster : end it, the light
 *                   goes); casting it again moves it.
 */
export class spellActions{
  static PULLS = { "thorn-whip" : { feet : 10, maxSize : "lg" } };
  static BY_HEALTH = ["toll-the-dead"];
  static STABILIZE = ["spare-the-dying"];
  static ATTACK_AFTER_ENCHANT = ["true-strike"];
  /* What a spell may enchant, by base weapon, where its data allows more (Shillelagh : any Simple Melee weapon) */
  static ENCHANT_ONLY = { "shillelagh" : ["club", "quarterstaff"] };
  static LIGHTS = {
    "light" : { place : "touch", seconds : 3600, light : { bright : 20, dim : 40, color : "#fff1c9", alpha : 0.25 } },
    "produce-flame" : { place : "self", seconds : 600, activity : /produce|cast/i, light : { bright : 20, dim : 40, color : "#ff9b3d", alpha : 0.35, animation : { type : "torch", speed : 3, intensity : 3 } } },
  };
  static SIZES = ["tiny", "sm", "med", "lg", "huge", "grg"];

  static enabled(){
    return spells.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.pullButtons(message, html));
    uses.onItem("byHealth", (item, ctx, next) => this.byHealthStep(item, ctx, next));
    uses.onActivity("spareTheDying", (activity, ctx, next) => this.stabilizeStep(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.afterEnchant(activity, usage, results));
    uses.onActivity("spellLight", (activity, ctx, next) => this.lightStep(activity, ctx, next));
    gm.handle("spellLight", data => this.lightAsGM(data));
    gm.handle("spellLightOff", data => this.lightOffAsGM(data));
    Hooks.on("deleteActiveEffect", effect => this.onLightEnded(effect));
  }

  /* ========== Pull (Thorn Whip) ========== */

  static pullButtons(message, html){
    if(!game.user.isGM || !this.enabled() || (message.type !== TYPES.attack)) return;
    const pull = this.PULLS[idOf(message.getAssociatedItem?.())];
    if(!pull || !message.system?.hitTargets) return;
    const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
    /* The hit tokens, as documents (hitTargets gives what the card resolves : a token or its document) */
    const tokens = [...new Set(rays.flatMap(r => message.system.hitTargets(r) ?? []).map(t => t?.document ?? t).filter(t => t?.uuid))];
    if(!tokens.length) return;
    const row = buttonRow(html, { key : `${module.id}-spell-pull` });
    if(row.childElementCount) return;
    for(const token of tokens){
      const size = token.actor?.system?.traits?.size ?? "med";
      if(this.SIZES.indexOf(size) > this.SIZES.indexOf(pull.maxSize)) continue;
      const key = `pulled.${token.uuid.replaceAll(".", "-")}`;
      addButton(row, makeButton({ icon : "fa-arrows-to-dot", once : true, disabled : !!message.getFlag(module.id, key),
        text : module.format("spellActions.pull", { name : token.name, feet : pull.feet }),
        onClick : async () => {
          const from = message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
          const moved = (token.object && from) ? await pullToward(token.object, from, pull.feet) : 0;
          if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : token.name }));
          await message.setFlag(module.id, key, true);
        } }));
    }
  }

  /* ========== By health (Toll the Dead) ========== */

  static async byHealthStep(item, ctx, next){
    if(!this.enabled() || !this.BY_HEALTH.includes(idOf(item)) || (game.user.targets.size !== 1)) return next();
    const activities = item.system.activities?.contents ?? [];
    if(activities.length < 2) return next();
    const actor = game.user.targets.first()?.actor;
    const hp = actor?.system?.attributes?.hp;
    if(!hp) return next();
    const hurt = Number(hp.value) < Number(hp.max);
    const activity = activities.find(a => (hurt ? /damag|hurt|wound|missing/i : /healthy|full|unharm/i).test(a.name ?? "")) ?? null;
    if(!activity) return next();
    const { chooseActivity, ...usage } = ctx.config ?? {};
    return activity.use(usage, ctx.dialog, ctx.message);
  }

  /* ========== Stabilize (Spare the Dying) ========== */

  static async stabilizeStep(activity, ctx, next){
    if(!this.enabled() || !this.STABILIZE.includes(idOf(activity?.item)) || !activity.actor?.isOwner) return next();
    const range = getRange(activity) || 15;
    const [target] = await pickTargets(activity.item, { count : 1, range, disposition : "any", includeSelf : true, useTargets : false,
      filter : t => actions.canStabilize(t.actor) });
    if(!target?.actor) return;
    uses.flag(ctx, { note : module.format("actions.kit.note", { name : target.name }) });
    const result = await next();
    if(result) await stabilize(target.actor);
    return result;
  }

  /* ========== Enchant (True Strike, Shillelagh) ========== */

  /* Cast : which of your items it enchants (held ones first), then True Strike's attack with it */
  static async afterEnchant(activity, usage, results){
    if(!this.enabled() || (activity?.type !== "enchant") || (activity.item?.type !== "spell") || activity.enchant?.self) return;
    const actor = activity.actor;
    if(!results?.message || !actor?.isOwner) return;
    const held = new Set(hands.heldItems(actor).map(i => i.id));
    const only = this.ENCHANT_ONLY[idOf(activity.item)];
    const eligible = actor.items.filter(i => (i !== activity.item) && (activity.canEnchant(i) === true) && (!only || only.includes(i.system.type?.baseItem) || only.includes(idOf(i))))
      .sort((a, b) => (held.has(b.id) - held.has(a.id)) || a.name.localeCompare(b.name));
    if(!eligible.length) return ui.notifications.warn(module.format("spellActions.noEnchant", { name : actor.name, spell : activity.item.name }));
    const id = (eligible.length === 1) ? eligible[0].id : await chooseOption({ title : activity.item.name, icon : "fa-solid fa-wand-magic-sparkles",
      prompt : module.i18n("spellActions.enchantPrompt"), value : eligible[0].id,
      options : eligible.map(i => ({ value : i.id, label : held.has(i.id) ? module.format("spellActions.inHand", { name : i.name }) : i.name })) });
    const item = id ? actor.items.get(id) : null;
    if(!item) return;
    const profile = usage?.enchantmentProfile ?? activity.effects?.[0]?._id;
    const concentration = (results.effects ?? []).find(e => e.statuses?.has?.("concentrating"));
    const enchantment = await activity.applyEnchantment(profile, item, { chatMessage : results.message, concentration });
    if(!enchantment) return;
    log.debug("Enchanted", item.name, "with", activity.item.name);
    /* True Strike : the attack with it now (the enchantment is what makes it use your spellcasting ability) */
    if(this.ATTACK_AFTER_ENCHANT.includes(idOf(activity.item))){
      const attack = actor.items.get(item.id)?.system?.activities?.find?.(a => a.type === "attack");
      const used = attack ? await attack.use() : null;
      /* Instantaneous : the enchantment ends once the attack's card is done */
      if(used) await uses.cardOf(used).catch(() => null);
      if(!enchantment.isDeleted) await enchantment.delete().catch(error => log.debug(error));
    }
  }

  /* ========== Light (Light, Produce Flame) ========== */

  static lightOf(activity){
    const spec = this.LIGHTS[idOf(activity?.item)];
    if(!spec || (spec.activity && !spec.activity.test(activity.name ?? ""))) return null;
    return spec;
  }

  static async lightStep(activity, ctx, next){
    const spec = this.enabled() ? this.lightOf(activity) : null;
    if(!spec) return next();
    const actor = activity.actor, caster = tokenOf(actor);
    if(!caster) return next();
    let where = null;
    if(spec.place === "self") where = { token : caster.document.uuid };
    else {
      const how = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-lightbulb", prompt : module.i18n("spellActions.lightWhere"),
        options : [{ value : "token", label : module.i18n("spellActions.lightToken") }, { value : "square", label : module.i18n("spellActions.lightSquare") }] });
      if(!how) return;
      const reach = canvas.scene?.grid.distance ?? 5;
      if(how === "token"){
        const [token] = await pickTargets(activity.item, { count : 1, range : reach, disposition : "any", includeSelf : true, useTargets : false, sight : false });
        if(!token) return;
        where = { token : token.document.uuid };
      }
      else {
        const space = await pickSpace(caster, { range : reach, occupied : true, banner : activity.item.name });
        if(!space) return;
        where = { scene : canvas.scene.id, x : space.x + (canvas.grid.size / 2), y : space.y + (canvas.grid.size / 2) };
      }
    }
    /* No summoning (Plutonium's Light is a summon) : the light is ours */
    ctx.config = { ...ctx.config, create : { ...(ctx.config?.create ?? {}), summons : false } };
    const result = await next();
    if(!result) return result;
    /* Cast again : the old light goes */
    const old = actor.effects.filter(e => e.getFlag(module.id, "spellLight")?.item === activity.item.uuid);
    if(old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old.map(e => e.id));
    const made = await gm.run("spellLight", { ...where, light : spec.light, key : `spell-${activity.item.id}` });
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : activity.item.name, img : activity.item.img, origin : activity.item.uuid,
      duration : { value : Math.round(spec.seconds / 60), units : "minutes" },
      flags : { [module.id] : { spellLight : { item : activity.item.uuid, key : `spell-${activity.item.id}`, ...where, light : made?.light ?? null } } },
    }]);
    return result;
  }

  /* GM : the light on a token (its own light, remembered to put back) or a light on a square */
  static async lightAsGM({ token, scene, x, y, light, key } = {}){
    if(token){
      const doc = fromUuidSync(token, { strict : false });
      if(doc) await addLight(doc, light, { key });
      return { token };
    }
    const target = game.scenes.get(scene);
    if(!target) return null;
    const [ambient] = await target.createEmbeddedDocuments("AmbientLight", [{ x, y, config : { ...light }, flags : { [module.id] : { spellLight : key } } }]);
    return { light : ambient?.id ?? null };
  }

  static async lightOffAsGM({ token, scene, light, key } = {}){
    if(token){
      const doc = fromUuidSync(token, { strict : false });
      if(doc) await removeLight(doc, { key });
      return true;
    }
    const target = game.scenes.get(scene);
    if(target && light && target.lights.get(light)) await target.deleteEmbeddedDocuments("AmbientLight", [light]);
    return true;
  }

  /* The caster's effect ended (expired, deleted, cast again) : the light goes (the active GM) */
  static async onLightEnded(effect){
    const data = effect?.getFlag?.(module.id, "spellLight");
    if(!data || !game.users.activeGM?.isSelf) return;
    await this.lightOffAsGM(data).catch(error => log.debug(error));
  }
}
