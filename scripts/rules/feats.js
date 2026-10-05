import { module } from '../module.js';
import { whisperOwners, esc } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { pickTargets } from '../helpers/targets.js';
import { findItem, usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { spendUses, getAppliedConditions } from '../helpers/items.js';
import { tokenOf, pushAway } from '../helpers/tokens.js';
import { masteries } from '../roll-item/masteries.js';
const log = logger.for(import.meta.url);

/**
 * Feats and features dnd5e has no data for, found on the character by item identifier (Species and Feats settings)
 * and applied at the stage they affect. Each is a small, self-contained rule.
 *
 *   Save traits     : advantage on saves against a condition (Brave : Frightened, Fey Ancestry : Charmed, Dwarven
 *                     Resilience : Poisoned), for saves rolled from a card whose activity applies it.
 *   Savage Attacker : a button on each weapon hit (for its owner) rolls the damage again as an alternative,
 *                     each roll with its own APPLY; once per turn in combat.
 *   Alert           : right after the Alert character's initiative is rolled, a card (to its owner and the GM) offers
 *                     to swap initiative with an ally in the combat, until the first turn passes, or "Do not swap".
 *                     Not while either is Incapacitated. Carried out by the GM, once the ally's player agrees (no
 *                     question when the asker owns both, or no other player owns the ally).
 *   Lucky           : after an attack roll, a Luck Point adds a second d20 : the attacker's owner keeps the higher, the
 *                     target's owner (attacked Lucky character) keeps the lower. Advantage and disadvantage cancel.
 *   Tavern Brawler  : the Unarmed Strike's own damage becomes 1d4 + STR, its 1s rerolled (Enhanced Unarmed Strike,
 *                     Damage Rerolls), unless it already rolls a die (a Monk's Martial Arts). Once per turn, a hit can
 *                     also push the target 5 ft (a GM button, like Push).
 *   Healer          : Healing Rerolls (1s on a spell's healing dice are rolled again). Battle Medic : using the feat
 *                     picks a creature within 5 ft, reads its remaining Hit Dice (its player picks the size when it has several),
 *                     and runs the matching "Heal dX" activity; it needs a Healer's Kit use, and spends the target's Hit
 *                     Die of that size when its owner applies it.
 */
export class feats{
  static INCAPACITATED = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

  /* Feats (Savage Attacker, Alert, Lucky, Tavern Brawler, Healer) */
  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("featRules");
  }

  /* Species traits (Brave, Fey Ancestry, Dwarven Resilience) */
  static speciesEnabled(){
    return (game.system.id === "dnd5e") && settings.value("speciesRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, context) => {
      this.savageButtons(message, buttons, context);
      this.luckyButtons(message, buttons, context);
      this.brawlerButtons(message, buttons, context);
    });
    Hooks.on(`${module.id}.cardButton`, (message, id, context) => {
      this.savageClicked(message, id, context);
      this.luckyClicked(message, id, context);
      this.brawlerClicked(message, id, context);
    });
    Hooks.on("dnd5e.preRollDamageV2", config => {
      this.healingRerolls(config);
      this.enhancedUnarmedStrike(config);
    });
    Hooks.on("dnd5e.preRollSavingThrowV2", (config, dialog, message) => this.onPreRollSave(config, message));
    Hooks.on("dnd5e.preUseActivity", activity => this.battleMedicKit(activity));
    Hooks.on("dnd5e.postUseActivity", activity => this.battleMedicSpendKit(activity));
    Hooks.on(`${module.id}.preApplyRow`, (message, actor) => this.battleMedicHitDie(message, actor));
    gm.handle("luckyAgainst", (data, user) => this.luckyAgainstAsGM(data, user));

    /* Using the Healer feat itself : Battle Medic, sized by the target's Hit Dice */
    uses.onItem("healer", (item, ctx, next) => {
      if(!ctx.config.chooseActivity && this.enabled() && ((item.identifier ?? item.system?.identifier) === this.HEALER)) return this.battleMedic(item, ctx.config.event);
      return next();
    });
    Hooks.on("updateCombatant", (combatant, changes, options) => this.onInitiative(combatant, changes, options));
    Hooks.on("renderChatMessageHTML", (message, html) => this.wireAlertCard(message, html));
    gm.handle("alertSwap", (data, user) => this.swapAsGM(data, user));
    CONFIG.queries[`${module.id}.ask`] = data => this.askHere(data);
  }

  /* ---------- Asking a creature's player ---------- */

  /**
   * The player who should answer for a creature : an active non-GM owner, not one of the excluded users.
   * @param {Actor} actor
   * @param {User[]} [exclude]
   * @returns {User|null}
   */
  static playerFor(actor, exclude = []){
    const skip = new Set(exclude.filter(Boolean).map(u => u.id));
    return game.users.find(u => u.active && !u.isGM && !skip.has(u.id) && actor?.testUserPermission(u, "OWNER")) ?? null;
  }

  /**
   * A question with buttons, asked on this client.
   * @param {{ title : string, icon? : string, content : string, buttons : { action : string, label : string, default? : boolean }[] }} data
   * @returns {Promise<string|null>}  the button's action, null when closed
   */
  static async askHere({ title, icon, content, buttons } = {}){
    return foundry.applications.api.DialogV2.wait({
      window : { title, icon }, content, buttons, rejectClose : false,
    }) ?? null;
  }

  /**
   * Ask a creature's player (see playerFor) : on their client, or here when there is no such player.
   * @param {Actor} actor
   * @param {object} data   askHere's question
   * @param {object} [options]
   * @param {User[]} [options.exclude]       users who don't count as "its player"
   * @param {string|null} [options.fallback] the answer when it has no player : undefined asks here instead
   * @returns {Promise<string|null>}
   */
  static async askPlayer(actor, data, { exclude = [], fallback } = {}){
    const player = this.playerFor(actor, exclude);
    if(!player) return (fallback !== undefined) ? fallback : this.askHere(data);
    if(player.isSelf) return this.askHere(data);
    try {
      return await player.query(`${module.id}.ask`, data, { timeout : 60000 });
    } catch(error){
      log.debug("No answer", player.name, error);
      return null;
    }
  }

  /* ---------- Save traits ---------- */

  /* Advantage on saves against these conditions, by the item identifier of the trait that grants it */
  static SAVE_ADVANTAGES = {
    "brave" : ["frightened"],
    "fey-ancestry" : ["charmed"],
    "dwarven-resilience" : ["poisoned"],
  };

  /* A save rolled from a card that applies a condition the saver has a trait against : advantage */
  static onPreRollSave(config, message){
    const trait = this.saveTraitFor(config.subject, game.messages.get(message?.data?.system?.origin));
    if(!trait) return;
    config.advantage = true;
    log.debug("Save advantage", config.subject.name, trait.name);
  }

  /**
   * The trait giving a creature advantage on a save rolled from this card (Brave against its Frightened...).
   * @param {Actor} actor
   * @param {ChatMessage} card
   * @returns {Item|null}
   */
  static saveTraitFor(actor, card){
    if(!this.speciesEnabled() || !actor?.items || !card) return null;
    const against = getAppliedConditions(card);
    if(!against.size) return null;
    return actor.items.find(i => (this.SAVE_ADVANTAGES[i.identifier ?? i.system?.identifier] ?? []).some(c => against.has(c))) ?? null;
  }

  /* ---------- Savage Attacker ---------- */

  static SAVAGE = "savage-attacker";

  static savageButtons(message, buttons, { ray } = {}){
    if(!this.enabled()) return;
    const actor = message.getAssociatedActor?.();
    const feat = actor && findItem(actor, this.SAVAGE);
    if(!feat || !actor.isOwner || (message.getAssociatedItem?.()?.type !== "weapon")) return;
    const card = message.system;
    if(!card?.isHitOn?.(ray) || card.extraRolls(ray, "savage").length || usedThisTurn(actor, "savage")) return;
    buttons.push({ id : "savage", label : feat.name, icon : "fa-hand-fist" });
  }

  static async savageClicked(message, id, { ray } = {}){
    if((id !== "savage") || !this.enabled()) return;
    const actor = message.getAssociatedActor?.();
    const feat = actor && findItem(actor, this.SAVAGE);
    if(!feat || !actor.isOwner) return;
    if(usedThisTurn(actor, "savage") && !limits.allow(module.format("feats.savage.used", { name : feat.name }), { who : actor.name, what : feat.name })) return;
    const rolls = await message.system.rollDamage(ray);
    await message.system.addDamage(rolls, { key : "savage", label : feat.name, ray, alternative : true });
    await markUsedThisTurn(actor, "savage");
  }

  /* ---------- Lucky ---------- */

  static LUCKY = "lucky";

  /* The Lucky feat, if it has a Luck Point left */
  static luckyOf(actor){
    const feat = actor && findItem(actor, this.LUCKY);
    return (feat && (Number(feat.system.uses?.value) > 0)) ? feat : null;
  }

  static luckyLabel(feat, mode){
    return module.format(`feats.lucky.${mode}`, { name : feat.name, left : feat.system.uses?.value ?? 0 });
  }

  static luckyButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || !message.system?.addD20) return;
    const used = message.getFlag?.(module.id, `lucky.${masteries.rayKey(ray)}`) ?? {};
    /* The attacker : advantage on their own roll */
    const attacker = message.getAssociatedActor?.();
    const mine = attacker?.isOwner && this.luckyOf(attacker);
    if(mine && !used.adv) buttons.push({ id : "lucky-adv", label : this.luckyLabel(mine, "adv"), icon : "fa-clover" });
    /* Someone attacked who owns a Lucky character : disadvantage on the roll against them */
    if(used.dis) return;
    for(const t of message.system.targetsOf(ray) ?? []){
      const target = dnd5e.dataModels.chatMessage.fields.TargetsField.resolve(t).actor;
      const feat = target?.isOwner && (target !== attacker) && this.luckyOf(target);
      if(feat){ buttons.push({ id : "lucky-dis", label : this.luckyLabel(feat, "dis"), icon : "fa-clover" }); break; }
    }
  }

  static async luckyClicked(message, id, { ray } = {}){
    if(!this.enabled() || !["lucky-adv", "lucky-dis"].includes(id)) return;
    const key = `lucky.${masteries.rayKey(ray)}`;
    if(id === "lucky-adv"){
      const attacker = message.getAssociatedActor?.();
      const feat = attacker?.isOwner && this.luckyOf(attacker);
      if(!feat || !message.isOwner) return;
      const result = await message.system.addD20(ray, "kh");
      if(result === "same") return ui.notifications.info(module.i18n("feats.lucky.same"));
      if(!result) return;
      await spendUses(feat, 1, { warn : false });
      await message.setFlag(module.id, key, { ...(message.getFlag(module.id, key) ?? {}), adv : true });
      return;
    }
    /* Against you : the card isn't yours, the GM changes it */
    const notes = await gm.run("luckyAgainst", { message : message.id, ray });
    for(const note of notes ?? []) ui.notifications.info(note);
  }

  /* GM : the asker must own an attacked Lucky character with a point left; once per attack */
  static async luckyAgainstAsGM({ message : id, ray = null } = {}, user){
    const message = game.messages.get(id);
    if(!message?.system?.addD20) throw new Error("Not a Roll Item attack card.");
    const key = `lucky.${masteries.rayKey(ray)}`;
    if(message.getFlag(module.id, key)?.dis) return [module.i18n("feats.lucky.done")];
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const target = (message.system.targetsOf(ray) ?? []).map(t => TargetsField.resolve(t).actor)
      .find(a => a && a.testUserPermission(user, "OWNER") && this.luckyOf(a));
    if(!target) return [module.i18n("feats.lucky.none")];
    const result = await message.system.addD20(ray, "kl");
    if(result === "same") return [module.i18n("feats.lucky.same")];
    if(!result) return [];
    await spendUses(this.luckyOf(target), 1, { warn : false });
    await message.setFlag(module.id, key, { ...(message.getFlag(module.id, key) ?? {}), dis : true });
    return [];
  }

  /* ---------- Tavern Brawler ---------- */

  static BRAWLER = "tavern-brawler";

  /* An Unarmed Strike (the item, or the feat's own Enhanced Unarmed Strike) by someone with the feat */
  static isBrawlerStrike(message){
    const actor = message.getAssociatedActor?.();
    const item = message.getAssociatedItem?.();
    const id = item?.identifier ?? item?.system?.identifier;
    return !!(actor && findItem(actor, this.BRAWLER) && ((id === "unarmed-strike") || (id === this.BRAWLER)));
  }

  /* The push is an outcome : the GM's button, once per turn */
  static brawlerButtons(message, buttons, { ray } = {}){
    if(!this.enabled() || !game.user.isGM || !message.system?.isHitOn?.(ray) || !this.isBrawlerStrike(message)) return;
    const actor = message.getAssociatedActor();
    if(usedThisTurn(actor, "brawlerPush") || message.getFlag(module.id, `brawler.${masteries.rayKey(ray)}`)) return;
    buttons.push({ id : "brawler-push", label : module.i18n("feats.brawler.push"), icon : "fa-hand" });
  }

  static async brawlerClicked(message, id, { ray } = {}){
    if((id !== "brawler-push") || !game.user.isGM || !this.isBrawlerStrike(message)) return;
    const actor = message.getAssociatedActor();
    const from = tokenOf(message.getAssociatedToken?.() ?? actor);
    for(const target of message.system.hitTargets(ray)){
      const moved = await pushAway(target, from, 5);
      if(settings.value("homebrewPush")) await masteries.pushCollision(target, moved, 5, message.getAssociatedItem());
      else if(!moved) ui.notifications.info(module.format("rollItem.mastery.blocked", { name : target.name }));
    }
    await markUsedThisTurn(actor, "brawlerPush");
    await message.setFlag(module.id, `brawler.${masteries.rayKey(ray)}`, true);
  }

  /* ---------- Healer ---------- */

  static HEALER = "healer";

  static isBattleMedic(activity){
    const id = activity?.item?.identifier ?? activity?.item?.system?.identifier;
    return (id === this.HEALER) && (activity.type === "heal");
  }

  static healersKit(actor){
    return actor?.items?.find(i => ((i.identifier ?? i.system?.identifier) === "healers-kit") || /^healer.?s kit$/i.test(i.name ?? "")) ?? null;
  }

  static BRAWLER = "tavern-brawler";

  /* Tavern Brawler : the Unarmed Strike's base damage "1 + STR" becomes "1d4r1 + STR" */
  static enhancedUnarmedStrike(config){
    if(!this.enabled()) return;
    const activity = config?.subject;
    const item = activity?.item;
    if((activity?.type !== "attack") || ((item?.identifier ?? item?.system?.identifier) !== "unarmed-strike")) return;
    if(!findItem(activity.actor, this.BRAWLER)) return;
    /* Unarmed Fighting's d6 / d8 is the better die (fighting-styles.js) */
    if(activity.actor.items?.some?.(i => ["unarmed-fighting", "fighting-style-unarmed-fighting"].includes(i.identifier ?? i.system?.identifier))) return;
    const base = item.system.damage?.base?.formula;
    if(!base || /\d*d\d+/i.test(base)) return;
    const enhanced = "1d4r1 + @mod";
    for(const roll of config.rolls ?? []){
      const i = (roll.parts ?? []).findIndex(p => String(p).replace(/\s+/g, "") === base.replace(/\s+/g, ""));
      if(i >= 0){ roll.parts[i] = enhanced; log.debug("Enhanced Unarmed Strike", activity.actor?.name); return; }
    }
  }

  /* Healing Rerolls : a spell's healing dice reroll 1s (once), for a caster with the Healer feat */
  static healingRerolls(config){
    if(!this.enabled()) return;
    const activity = config?.subject;
    if((activity?.type !== "heal") || (activity.item?.type !== "spell") || !findItem(activity.actor, this.HEALER)) return;
    for(const roll of config.rolls ?? []){
      roll.parts = (roll.parts ?? []).map(part => String(part).replace(/(\d*d\d+)(?![a-z0-9])/gi, "$1r1"));
    }
  }

  /**
   * Battle Medic : pick a creature within 5 ft (yourself too), read its remaining Hit Dice, and use the Healer's
   * "Heal dX" activity of that size (asking which when it has several). The kit and the Hit Die are handled when the
   * activity is used and when its healing is applied.
   */
  static async battleMedic(item, event){
    const activities = item.system.activities?.filter(a => a.type === "heal") ?? [];
    if(!activities.length) return null;
    if(this.battleMedicKit(activities[0]) === false) return null;

    const pick = settings.value("rollItemPick");
    const [token] = await pickTargets(item, { count : 1, range : canvas.scene?.grid.distance ?? 5, disposition : "any",
      includeSelf : true, useTargets : pick !== "always", confirm : "auto" });
    const target = token?.actor;
    if(!target) return null;

    /* Its Hit Dice : remaining, by size */
    const sizes = new Map();
    for(const cls of target.items.filter(i => i.type === "class")){
      const left = Number(cls.system.hd?.value) || 0;
      const die = String(cls.system.hd?.denomination ?? "");
      if(left > 0 && die) sizes.set(die, (sizes.get(die) ?? 0) + left);
    }
    if(!sizes.size){
      ui.notifications.warn(module.format("feats.healer.noHitDice", { name : target.name }));
      return null;
    }
    let die = [...sizes.keys()][0];
    if(sizes.size > 1){
      /* It's the healed creature's Hit Die to spend : its player picks the size (the healer when it's theirs or an NPC) */
      const player = this.playerFor(target);
      if(player && !player.isSelf) ui.notifications.info(module.format("feats.healer.asking", { name : target.name, player : player.name }));
      die = await this.askPlayer(target, {
        title : item.name, icon : "fa-solid fa-kit-medical",
        content : `<p>${module.format("feats.healer.chooseDie", { name : foundry.utils.escapeHTML(target.name), healer : foundry.utils.escapeHTML(item.actor?.name ?? "") })}</p>`,
        buttons : [...sizes].sort((a, b) => parseInt(b[0].slice(1)) - parseInt(a[0].slice(1))).map(([d, left], i) => ({
          action : d, label : `${d} (${left})`, default : i === 0,
        })),
      });
      if(!die || !sizes.has(die)) return null;
    }

    const activity = activities.find(a => new RegExp(`\\b${die}\\b`, "i").test(a.name ?? ""));
    if(!activity){
      ui.notifications.warn(module.format("feats.healer.noActivity", { item : item.name, die }));
      return null;
    }
    return activity.use({ event, [module.id] : { skipPick : true } });
  }

  /* Battle Medic needs a Healer's Kit use */
  static battleMedicKit(activity){
    if(!this.enabled() || !this.isBattleMedic(activity)) return;
    const kit = this.healersKit(activity.actor);
    if(kit && (!(Number(kit.system.uses?.max) > 0) || (Number(kit.system.uses?.value) > 0))) return;
    ui.notifications.warn(module.i18n("feats.healer.noKit"));
    return false;
  }

  static async battleMedicSpendKit(activity){
    if(!this.enabled() || !this.isBattleMedic(activity) || !activity.actor?.isOwner) return;
    const kit = this.healersKit(activity.actor);
    if(kit && (Number(kit.system.uses?.max) > 0)) await spendUses(kit, 1, { warn : false });
  }

  /* Battle Medic : the target spends one of its Hit Dice of the size used ("Heal d8"), or it can't be applied */
  static battleMedicHitDie(message, actor){
    if(!this.enabled()) return;
    const activity = message.getAssociatedActivity?.();
    if(!this.isBattleMedic(activity)) return;
    const size = String(activity.name ?? "").match(/d(\d+)/i)?.[1];
    if(!size) return;
    const cls = (actor.items?.filter?.(i => i.type === "class") ?? [])
      .find(c => (String(c.system.hd?.denomination) === `d${size}`) && (Number(c.system.hd?.value) > 0));
    if(!cls){
      ui.notifications.warn(module.format("feats.healer.noHitDie", { name : actor.name, die : `d${size}` }));
      return false;
    }
    cls.update({ "system.hd.spent" : (Number(cls.system.hd.spent) || 0) + 1 });
  }

  /* ---------- Alert ---------- */

  static ALERT = "alert";

  /* A combatant's initiative was just rolled (or set) : the active GM posts the swap card for an Alert character */
  static async onInitiative(combatant, changes, options = {}){
    if(!this.enabled() || !("initiative" in (changes ?? {})) || (changes.initiative === null)) return;
    if(options?.[module.id]?.alertSwap) return;   // our own swap, not a new roll
    if(!game.users.activeGM?.isSelf) return;
    const actor = combatant.actor;
    if(!actor || !findItem(actor, this.ALERT)) return;
    const combat = combatant.combat ?? combatant.parent;
    const allies = this.alliesOf(combatant, combat);
    if(!allies.length) return;

    /* Compact Initiative : the offer goes on the round's initiative card (swap buttons on the allies' rows) */
    if(settings.value("initiativeMessages") === "compact"){
      await combat.setFlag(module.id, `alert.${combatant.id}`, { round : combat.round, turn : combat.turn ?? 0, done : false });
      log.debug("Alert swap offered on the initiative card", actor.name);
      return;
    }

    const rows = allies.map(c => `
      <li class="macro-helper-row">
        <img class="token" src="${esc(c.img)}" alt="">
        <span class="name">${esc(c.name)}</span>
        <span class="result">${c.initiative ?? "—"}</span>
        <button type="button" data-macro-helper-alert="${c.id}"><i class="fa-solid fa-right-left" inert></i> ${module.i18n("feats.alert.swap")}</button>
      </li>`).join("") + `
      <li class="macro-helper-row">
        <button type="button" data-macro-helper-alert=""><i class="fa-solid fa-ban" inert></i> ${module.i18n("feats.alert.keep")}</button>
      </li>`;
    await whisperOwners(actor, `<div class="macro-helper-alert"><p><strong>${module.i18n("feats.alert.title")}</strong> : ${module.format("feats.alert.hint", { initiative : combatant.initiative })}</p><ul class="unlist macro-helper-rows">${rows}</ul></div>`,
      { flags : { [module.id] : { alert : { combat : combat.id, combatant : combatant.id, round : combat.round, turn : combat.turn ?? 0, done : false } } } });
    log.debug("Alert swap offered", actor.name, allies.map(c => c.name));
  }

  /* Allies in the same combat who could swap : same side, not the Alert character, initiative rolled, not incapacitated */
  static alliesOf(combatant, combat){
    const side = combatant.token?.disposition ?? combatant.actor?.prototypeToken?.disposition;
    return (combat?.combatants?.contents ?? [...(combat?.combatants ?? [])]).filter(c => (c.id !== combatant.id)
      && (c.initiative !== null) && c.actor
      && ((c.token?.disposition ?? c.actor.prototypeToken?.disposition) === side)
      && !this.INCAPACITATED.some(s => c.actor.statuses?.has(s)));
  }

  /**
   * An Alert offer and how to close it : from its own card ({ message }), or from the combat (Compact Initiative :
   * { combat, combatant }).
   * @returns {{ info : object|null, read : () => object|null, close : () => Promise }}
   */
  static alertOffer({ message : id, combat : combatId, combatant : combatantId } = {}){
    if(id){
      const message = game.messages.get(id);
      return { info : message?.getFlag(module.id, "alert") ?? null, read : () => message?.getFlag(module.id, "alert"),
        close : () => message.setFlag(module.id, "alert.done", true) };
    }
    const combat = game.combats.get(combatId);
    const read = () => {
      const info = combat?.getFlag(module.id, `alert.${combatantId}`);
      return info ? { ...info, combat : combatId, combatant : combatantId } : null;
    };
    return { info : read(), read, close : () => combat.setFlag(module.id, `alert.${combatantId}.done`, true) };
  }

  /* The open offers of a combat's Alert characters (Compact Initiative) : [{ combatant, info }] */
  static openAlerts(combat){
    const offers = combat?.getFlag?.(module.id, "alert") ?? {};
    return Object.keys(offers).map(id => ({ combatant : combat.combatants.get(id), info : this.alertOffer({ combat : combat.id, combatant : id }).info }))
      .filter(o => o.combatant && this.inTime(o.info));
  }

  /**
   * Two combatants' initiative after Alert's swap. The rolled initiative trades places; dnd5e's ability score
   * tie-breaker (DEX 14 : +0.14 in the initiative) belongs to each creature, so each keeps its own.
   * @returns {{ a : number, b : number }}
   */
  static swappedInitiatives(a, b){
    const tie = c => {
      let on = false;
      try { on = game.settings.get("dnd5e", "initiativeDexTiebreaker"); } catch { on = false; }
      if(!on) return 0;
      const ability = c.actor?.system?.attributes?.init?.ability || CONFIG.DND5E.defaultAbilities?.initiative || "dex";
      const value = Number(c.actor?.system?.abilities?.[ability]?.value);
      return Number.isFinite(value) ? value / 100 : 0;
    };
    const round = n => Math.round(n * 100) / 100;
    const ta = tie(a), tb = tie(b);
    return { a : round((b.initiative - tb) + ta), b : round((a.initiative - ta) + tb) };
  }

  /* Still in time : the same combat, no turn has passed since the roll */
  static inTime(info){
    const combat = game.combats.get(info?.combat);
    return !!combat && !info.done && (combat.round === info.round) && ((combat.turn ?? 0) === info.turn);
  }

  static wireAlertCard(message, html){
    const info = message.getFlag?.(module.id, "alert");
    if(!info) return;
    const open = this.inTime(info);
    for(const button of html.querySelectorAll("[data-macro-helper-alert]")){
      button.disabled = !open;
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        const ally = button.dataset.macroHelperAlert || null;
        if(ally) ui.notifications.info("feats.alert.asking", { localize : true });
        try {
          /* The GM may wait on the ally's player : give it time */
          const notes = await gm.run("alertSwap", { message : message.id, ally }, { timeout : 90000 });
          for(const note of notes ?? []) ui.notifications.info(note);
        } catch(error){
          ui.notifications.warn(error.message);
        } finally {
          button.disabled = !this.inTime(message.getFlag(module.id, "alert"));
        }
      });
    }
  }

  /**
   * Done by the GM's client : the asker must own the Alert character, it must still be in time, and both must be able
   * to swap (in the combat, allies, not Incapacitated). The ally's player is asked (unless the asker owns it too, or
   * no other player does); then the two initiatives trade places. No ally (null) : "Do not swap", the card closes.
   */
  static async swapAsGM({ message : id, combat : combatId, combatant : combatantId, ally : allyId } = {}, user){
    const offer = this.alertOffer({ message : id, combat : combatId, combatant : combatantId });
    const info = offer.info;
    const combat = game.combats.get(info?.combat);
    const combatant = combat?.combatants.get(info?.combatant);
    if(!combatant) throw new Error("This Alert card no longer matches a combat.");
    if(!user?.isGM && !combatant.actor?.testUserPermission(user, "OWNER")) throw new Error("Only the Alert character's owner can swap.");
    if(!this.inTime(info)) return [module.i18n("feats.alert.late")];
    if(!allyId){
      await offer.close();
      return [module.format("feats.alert.kept", { a : combatant.name })];
    }
    if(this.INCAPACITATED.some(s => combatant.actor?.statuses?.has(s))) return [module.i18n("feats.alert.incapacitated")];
    const ally = this.alliesOf(combatant, combat).find(c => c.id === allyId);
    if(!ally) return [module.i18n("feats.alert.noAlly")];

    /* The ally's player agrees to it (not the asker, not a GM) */
    const mineFirst = combatant.initiative, theirsFirst = ally.initiative;
    const answer = await this.askPlayer(ally.actor, {
      title : module.i18n("feats.alert.title"), icon : "fa-solid fa-right-left",
      content : `<p>${module.format("feats.alert.askHint", { a : foundry.utils.escapeHTML(combatant.name), b : foundry.utils.escapeHTML(ally.name), mine : mineFirst, theirs : theirsFirst })}</p>`,
      buttons : [
        { action : "yes", label : module.i18n("feats.alert.accept"), icon : "fa-solid fa-check", default : true },
        { action : "no", label : module.i18n("feats.alert.decline"), icon : "fa-solid fa-xmark" },
      ],
    }, { exclude : [user], fallback : "yes" });
    if(answer !== "yes") return [module.format("feats.alert.declined", { b : ally.name })];
    if(!this.inTime(offer.read())) return [module.i18n("feats.alert.late")];

    const swapped = this.swappedInitiatives(combatant, ally);
    await combat.updateEmbeddedDocuments("Combatant", [{ _id : combatant.id, initiative : swapped.a }, { _id : ally.id, initiative : swapped.b }],
      { [module.id] : { alertSwap : true } });
    await offer.close();
    return [module.format("feats.alert.swapped", { a : combatant.name, b : ally.name })];
  }
}
