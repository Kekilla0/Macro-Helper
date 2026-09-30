import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { TYPES, registerMessages } from './message.js';
const log = logger.for(import.meta.url);

/**
 * One-click rolling onto a single dnd5e-style card, using dnd5e's own roll math.
 *  attack : attack + damage rolled together
 *  save   : damage rolled up front, save buttons for the targets, damage tray halves for those who saved
 *  heal   : healing rolled up front with its apply tray (same card as save, dnd5e's usage card + the roll)
 */
export class rollItem{

  /**
   * @param {Item5e} item
   * @param {object} [options]
   * @param {string} [options.activity]  id or name of the activity, defaults to the first attack, then save, then heal
   * @param {Event}  [options.event]     triggering event, read for advantage/disadvantage keys
   * @param {number} [options.count]     number of attack rolls, overrides the activity's Attack Count formula
   */
  static async roll(item, { activity, event, count } = {}){
    const target = this.getActivity(item, activity);
    if(!target) return ui.notifications.warn(module.format("rollItem.warn.noAttack", { name : item?.name ?? "" }));

    /* Saves / heals go through dnd5e's use workflow (spell slots, uses, templates, effects), flagged so we take over the card */
    if(target.type !== "attack") return target.use({ event, [module.id] : { mode : target.type } });

    return this.rollActivity(target, { event, count });
  }

  /**
   * Roll an attack activity directly.
   * @param {Activity} activity   an attack activity, possibly a scaled clone from dnd5e's use workflow
   * @param {object} [options]
   * @param {Event}  [options.event]
   * @param {number} [options.scaling]  upcast levels, stored so rerolls keep them
   * @param {number} [options.count]    number of attack rolls, defaults to the activity's Attack Count formula
   */
  static async rollActivity(activity, { event, scaling = 0, count } = {}){
    if(!this.ready("attack")) return;

    const rays = this.countFor(activity, count);
    if(rays > 1) return this.rollRays(activity, rays, { event, scaling });

    const roll = await this.rollAttack(activity, event);
    if(!roll) return;
    const damage = await this.rollDamage(activity, roll);

    /* On-hit save from the same item (Giant Spider's poison) : its damage is rolled now too, never crits */
    const save = this.findRider(activity);
    const riderDamage = save ? await this.rollDamage(save, null) : [];
    for(const r of riderDamage) r.options[module.id] = { part : "save" };
    const rider = save ? {
      id : save.id,
      ability : save.save.ability.first() ?? "",
      dc : Number.isFinite(save.save.dc.value) ? save.save.dc.value : null,
      onSave : save.damage?.onSave ?? null,
    } : null;

    const message = await this.attackCard(activity, [roll, ...damage, ...riderDamage], { scaling, rider });
    log.debug("Rolled", activity.item.name, { roll, damage, rider, riderDamage });

    return { attack : roll, damage, riderDamage, isCritical : roll.isCritical, isFumble : roll.isFumble, message };
  }

  /**
   * A save activity on the same item that only happens as part of another action (activation "special"),
   * which is how dnd5e builds on-hit riders : Giant Spider Bite, Giant Poisonous Snake Bite, Wolf Bite, Ghoul Claws.
   */
  static findRider(activity){
    return activity?.item?.system.activities?.find(a =>
      (a.type === "save") && (a.id !== activity.id) && (a.activation?.type === "special")
    ) ?? null;
  }

  /* ---------- Multiple attack rolls (Scorching Ray, Eldritch Blast...) ---------- */

  static get countFlag(){ return `flags.${module.id}.count`; }

  /**
   * Built-in counts for spells that make several attack rolls, by dnd5e item identifier.
   * @scaling is the cantrip tier (1-4) for cantrips, 1 + upcast levels for leveled spells.
   */
  static DEFAULT_COUNTS = {
    "scorching-ray" : "2 + @scaling",   // 3 rays at 2nd level, +1 per level above
    "eldritch-blast" : "@scaling",      // 1 / 2 / 3 / 4 beams at levels 1 / 5 / 11 / 17
    "magic-missile" : "2 + @scaling",   // 3 darts at 1st level, +1 per level above (damage only, no attack roll)
  };

  /* Attack Count flag on the activity, else the built-in default for the spell */
  static countFormula(activity){
    return foundry.utils.getProperty(activity, this.countFlag) || this.DEFAULT_COUNTS[activity?.item?.identifier] || "";
  }

  /* Evaluated with the activity's roll data, on dnd5e's scaled clone this includes the cast level */
  static countFor(activity, count){
    if(Number.isFinite(count)) return Math.max(1, Math.floor(count));
    const formula = this.countFormula(activity);
    if(!formula) return 1;
    const value = dnd5e.utils.simplifyBonus(formula, activity.getRollData());
    return Math.max(1, Math.floor(value) || 1);
  }

  /* Spread rays over the current targets in order : 4 rays, 2 targets -> A A B B */
  static assignTargets(count){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const targets = TargetsField.getDescriptors();
    return Array.from({ length : count }, (_, i) => targets.length ? targets[Math.floor(i * targets.length / count)] : null);
  }

  /* A miss is below the target's AC or a fumble, a crit always hits, no AC known counts as a hit */
  static isHit(roll){
    if(!roll) return false;
    if(roll.isCritical) return true;
    if(roll.isFumble) return false;
    const ac = roll.options.target;
    return !Number.isFinite(ac) || roll.total >= ac;
  }

  /**
   * One ray : attack against its target's AC plus its damage, rolled either way so the GM can still apply a "miss".
   * Rolls are tagged with the ray index.
   * @returns {Promise<Roll[]|null>}  null if the attack was cancelled
   */
  static async rollRay(activity, event, index, target){
    const attack = await this.rollAttack(activity, event, Number.isFinite(target?.ac) ? { target : target.ac } : {});
    if(!attack) return null;
    const damage = await this.rollDamage(activity, attack);
    for(const roll of [attack, ...damage]) roll.options[module.id] = { ray : index };
    return [attack, ...damage];
  }

  static async rollRays(activity, count, { event, scaling = 0 } = {}){
    const targets = this.assignTargets(count);
    const rolls = [];
    for(const [index, target] of targets.entries()){
      const ray = await this.rollRay(activity, event, index, target);
      if(!ray) return;
      rolls.push(...ray);
    }

    const rays = targets.map(t => ({ target : t?.token ?? "" }));
    const message = await this.attackCard(activity, rolls, { scaling, rays });
    log.debug("Rolled rays", activity.item.name, { rolls, rays });

    return { rolls, message };
  }

  /* Activity sheet ⋯ menu : set the Attack Count formula */
  static async editCount(activity){
    const current = foundry.utils.getProperty(activity, this.countFlag) ?? "";
    const value = await foundry.applications.api.DialogV2.prompt({
      window : { title : `${module.i18n("rollItem.count.title")}: ${activity.name}`, icon : "fa-solid fa-layer-group" },
      content : `
        <div class="form-group">
          <label>${module.i18n("rollItem.count.label")}</label>
          <div class="form-fields">
            <input type="text" name="count" value="${Handlebars.escapeExpression(current)}"
              placeholder="${Handlebars.escapeExpression(this.DEFAULT_COUNTS[activity.item?.identifier] ?? "1")}" autofocus>
          </div>
          <p class="hint">${module.i18n("rollItem.count.hint")}</p>
        </div>`,
      ok : { label : "rollItem.count.save", callback : (_event, button) => button.form.elements.count.value.trim() },
      rejectClose : false,
    });
    if(value === null || value === undefined) return;

    if(value){
      try { new Roll(value, activity.getRollData()); }
      catch(err) { return ui.notifications.error(module.format("rollItem.count.invalid", { formula : value })); }
    }
    await activity.update({ [this.countFlag] : value || null });
    ui.notifications.info(module.format("rollItem.count.saved", { name : activity.name, count : this.countFor(activity) }));
  }

  /* Setting on, and the message type registered (subtypes come from module.json, which the server only reads when Foundry starts) */
  static ready(mode, { notify = true } = {}){
    if(!settings.value("rollItem")){
      if(notify) ui.notifications.warn("rollItem.warn.disabled", { localize : true });
      return false;
    }
    if(!game.documentTypes.ChatMessage?.includes(this.typeFor(mode))){
      if(notify) ui.notifications.error("rollItem.error.type", { localize : true });
      return false;
    }
    return true;
  }

  /* Attack cards have their own message type, saves and heals share the usage-card-with-a-roll type */
  static typeFor(mode){
    return mode === "attack" ? TYPES.attack : TYPES.save;
  }

  /* ---------- dnd5e's use workflow, with our card instead of its usage card + prompts ---------- */

  /* Which activity types each "Roll Item for ..." setting covers */
  static DEFAULT_MODES = {
    attack : "rollItemDefault",
    save : "rollItemSaves",
    heal : "rollItemHeals",
    damage : "rollItemDamage",
  };

  static modeFor(activity, usage){
    let mode = usage?.[module.id]?.mode;
    const setting = this.DEFAULT_MODES[activity?.type];
    if(!mode && setting && settings.value(setting)) mode = activity.type;
    return mode && this.ready(mode, { notify : !!usage?.[module.id] }) ? mode : null;
  }

  /* Let dnd5e handle dialogs, consumption, concentration and templates, but skip its card and follow-up prompts */
  static onPreUse(activity, usage, _dialog, message){
    const mode = rollItem.modeFor(activity, usage);
    if(!mode) return;
    message.create = false;
    usage.subsequentActions = false;
    usage[module.id] = { mode };
  }

  /* activity here is dnd5e's scaled clone, so upcast spells roll at the cast level */
  static onPostUse(activity, usage, results){
    switch(usage[module.id]?.mode){
      case "attack" :
        return void rollItem.rollActivity(activity, { event : usage.event, scaling : activity.item.getFlag("dnd5e", "scaling") ?? 0 });
      case "save" :
      case "heal" :
      case "damage" :
        return void rollItem.usageCard(activity, results.message);
    }
  }

  /* ---------- Rolling ---------- */

  /* dnd5e attack roll, no dialog, no message */
  static async rollAttack(activity, event, config = {}){
    const [roll] = await activity.rollAttack({ ...config, event : this.keyEvent(event) }, { configure : false }, { create : false }) ?? [];
    return roll ?? null;
  }

  /* Heal activities keep their formula in `healing`, everything else in `damage.parts` */
  static hasDamage(activity){
    return activity?.type === "heal" ? !!activity.healing?.formula : !!activity?.damage?.parts?.length;
  }

  /* dnd5e damage (or healing) roll, no dialog, no message. Same hand-off dnd5e does from its attack card to its damage roll */
  static async rollDamage(activity, attack){
    if(!this.hasDamage(activity)) return [];
    const { ability, ammunition, attackMode } = attack?.options ?? {};
    return await activity.rollDamage({
      ability, attackMode,
      ammunition : activity.actor?.items.get(ammunition),
      isCritical : attack?.isCritical ?? false,
    }, { configure : false }, { create : false }) ?? [];
  }

  /**
   * Play Dice So Nice for rolls that are not being added to a new message (DSN animates those itself),
   * resolves once the dice have landed. Visibility follows the message's roll mode.
   */
  static async showDice(rolls, message){
    if(!game.dice3d){
      foundry.audio.AudioHelper.play({ src : CONFIG.sounds.dice }, true);
      return;
    }
    const whisper = message.whisper.length ? message.whisper : null;
    await Promise.all(rolls.map(roll => game.dice3d.showForRoll(roll, game.user, true, whisper, message.blind, message.id, message.speaker)));
  }

  static getActivity(item, id){
    const activities = item?.system?.activities;
    if(!activities) return null;
    const usable = ["attack", "save", "damage", "heal"].flatMap(type => activities.getByType(type));
    if(!id) return usable[0] ?? null;
    return usable.find(a => a.id === id || a.name === id) ?? null;
  }

  /**
   * dnd5e reads advantage/disadvantage from an event using its keybindings (Configure Controls).
   * Macros may not have an event, so fall back to what is held down right now.
   */
  static keyEvent(event){
    if(!settings.value("rollItemHotkeys")) return undefined;
    if(event) return event;

    const kb = game.keyboard;
    return {
      altKey : kb.isModifierActive("ALT"),
      ctrlKey : kb.isModifierActive("CONTROL"),
      shiftKey : kb.isModifierActive("SHIFT"),
      metaKey : false,
      target : document.body,
    };
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    registerMessages();
    Hooks.on("dnd5e.preUseActivity", rollItem.onPreUse);
    Hooks.on("dnd5e.postUseActivity", rollItem.onPostUse);

    Hooks.on("getHeaderControlsActivitySheet", (app, controls)=> {
      if(!["attack", "damage"].includes(app.document?.type)) return;
      controls.push({
        icon : "fa-solid fa-layer-group",
        label : "rollItem.count.control",
        visible : ()=> app.isEditable,
        onClick : ()=> rollItem.editCount(app.document),
      });
    });
  }

  /* ---------- Cards ---------- */

  /**
   * Attack : one message of our attack type, the rolls are attached so dnd5e renders them.
   * @param {Roll[]} rolls  attack roll(s) + damage rolls, multi-ray rolls tagged with options[module.id].ray
   * @param {object[]} [rays]  one { target : tokenUuid } per ray when rolling more than one attack
   */
  static async attackCard(activity, rolls, { scaling = 0, rays = [], rider = null } = {}){
    const attack = rolls.find(r => r instanceof CONFIG.Dice.D20Roll);
    const { ability, ammunition, attackMode, mastery } = attack?.options ?? {};
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;

    const messageData = {
      type : TYPES.attack,
      speaker : ChatMessage.implementation.getSpeaker({ actor : activity.actor }),
      rolls,
      system : {
        ...activity.messageSources,
        targets : TargetsField.getDescriptors(),
        ability, ammunition, mastery, scaling, rays, rider,
        mode : attackMode,
      },
    };
    ChatMessage.implementation.applyMode(messageData, CONFIG.Dice.BasicRoll.getMessageMode());

    return await ChatMessage.implementation.create(messageData);
  }

  /**
   * Save / heal : dnd5e already built its usage card data (buttons, targets, effects, scaling, roll mode) but did not create it.
   * Roll the damage (or healing) onto it, swap its "roll damage/healing" button for a reroll, and create it as our type.
   */
  static async usageCard(activity, data){
    if(!data?.system) return;
    const isHeal = activity.type === "heal";
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    data.system.targets ??= TargetsField.getDescriptors();

    /* Damage-only activities can roll several instances (Magic Missile darts), spread over the targets like rays */
    const count = activity.type === "damage" ? this.countFor(activity) : 1;
    const damage = [];
    if(count > 1){
      const targets = this.assignTargets(count);
      for(const i of targets.keys()){
        const rolls = await this.rollDamage(activity, null);
        for(const roll of rolls) roll.options[module.id] = { ray : i };
        damage.push(...rolls);
      }
      data.system.rays = targets.map(t => ({ target : t?.token ?? "" }));
    }
    else damage.push(...await this.rollDamage(activity, null));

    data.type = TYPES.save;
    data.rolls = [...(data.rolls ?? []), ...damage];
    data.system.onSave = activity.damage?.onSave ?? null;
    data.system.buttons = (data.system.buttons ?? []).filter(b => !["rollDamage", "rollHealing"].includes(b.action));
    if(damage.length) data.system.buttons.push({
      action : "rerollDamage",
      icon : isHeal ? "systems/dnd5e/icons/svg/damage/healing.svg" : "fa-solid fa-burst",
      label : { value : isHeal ? "rollItem.reroll.healing" : "rollItem.reroll.damage" },
    });
    if(count > 1 && damage.length) data.system.buttons.push({
      action : "applyRays",
      icon : "fa-solid fa-heart-crack",
      label : { value : "rollItem.apply.all" },
    });

    log.debug("Usage card", activity.item.name, { data, damage });
    return await ChatMessage.implementation.create(data);
  }
}
