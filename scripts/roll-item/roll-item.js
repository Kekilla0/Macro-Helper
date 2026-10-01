import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { patch } from '../patch.js';
import { TYPES, registerMessages } from './message.js';
import { tokenOf } from '../helpers/tokens.js';
import { pickAttack, getMultiattackPlan, multiattack } from '../helpers/items.js';
import { masteries } from './masteries.js';
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
   * @param {string|Function} [options.attackMode]  dnd5e attack mode ("thrown", "twoHanded"...), or (targetToken) => mode
   *                                     per attack. Thrown attacks use up the weapon, like dnd5e's own thrown attacks.
   * @param {boolean|Function} [options.disadvantage]  roll with disadvantage, or (targetToken) => boolean per attack
   *                                     (long range...). Combines with the advantage keys like dnd5e : both = a normal roll.
   * @param {Token[]} [options.targets]  attack these, one attack each in order (the same token twice = two attacks at it),
   *                                     instead of spreading `count` over your targets. `count` defaults to their number.
   * @param {boolean} [options.cleave]   the Cleave mastery's extra attack : its damage leaves out a positive ability modifier
   */
  static async roll(item, { activity, event, count, attackMode, disadvantage, targets, cleave } = {}){
    const target = this.getActivity(item, activity);
    if(!target) return ui.notifications.warn(module.format("rollItem.warn.noAttack", { name : item?.name ?? "" }));

    /* Saves / heals go through dnd5e's use workflow (spell slots, uses, templates, effects), flagged so we take over the card */
    if(target.type !== "attack") return target.use({ event, [module.id] : { mode : target.type } });

    return this.rollActivity(target, { event, count, attackMode, disadvantage, targets, cleave });
  }

  /* A per-attack option for one target : a fixed value, or chosen per target by a function */
  static perTarget(value, target){
    if(typeof value === "function") return value(target) ?? undefined;
    return value ?? undefined;
  }

  /* dnd5e attack roll config for one target : attack mode, disadvantage, and who it's aimed at (Vex) */
  static attackConfig({ attackMode, disadvantage } = {}, target){
    const config = {};
    const uuid = target?.document?.uuid ?? target?.uuid;
    if(uuid) config[module.id] = { target : uuid };
    const mode = this.perTarget(attackMode, target);
    if(mode) config.attackMode = mode;
    if(this.perTarget(disadvantage, target)) config.disadvantage = true;
    return config;
  }

  /**
   * Roll an attack activity directly.
   * @param {Activity} activity   an attack activity, possibly a scaled clone from dnd5e's use workflow
   * @param {object} [options]
   * @param {Event}  [options.event]
   * @param {number} [options.scaling]  upcast levels, stored so rerolls keep them
   * @param {number} [options.count]    number of attack rolls, defaults to the activity's Attack Count formula
   * @param {string|Function} [options.attackMode]    see roll()
   * @param {boolean|Function} [options.disadvantage]  see roll()
   * @param {Token[]} [options.targets]                 see roll()
   * @param {boolean} [options.cleave]                  see roll()
   */
  static async rollActivity(activity, { event, scaling = 0, count, attackMode, disadvantage, targets, cleave } = {}){
    if(!this.ready("attack")) return;

    /* Advantage / disadvantage for the whole card : the keys held, or asked now (targets are already chosen) */
    const mode = await this.chooseMode(activity, event);
    if(!mode) return;

    const rays = this.countFor(activity, count ?? targets?.length);
    if(rays > 1) return this.rollRays(activity, rays, { event, scaling, attackMode, disadvantage, targets, mode });

    const target = targets?.[0] ?? game.user.targets.first() ?? null;
    const config = this.attackConfig({ attackMode, disadvantage }, target);
    const roll = await this.rollAttack(activity, event, config, mode);
    if(!roll) return;
    if(cleave) roll.options[module.id] = { ...(roll.options[module.id] ?? {}), noMod : true };
    const damage = await this.rollDamage(activity, roll);
    /* Graze : its damage for a miss, the card shows it when the attack misses */
    const graze = await masteries.grazeRolls(activity, roll, damage);
    for(const r of graze) r.options[module.id] = { part : "graze" };

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

    const message = await this.attackCard(activity, [roll, ...damage, ...graze, ...riderDamage], { scaling, rider, disadvantage : !!config.disadvantage });
    log.debug("Rolled", activity.item.name, { roll, damage, rider, riderDamage });

    return { attack : roll, damage, riderDamage, isCritical : roll.isCritical, isFumble : roll.isFumble, message };
  }

  /**
   * A save activity on the same item that only happens as part of another action (activation "special"),
   * which is how dnd5e builds on-hit riders : Giant Spider Bite, Giant Poisonous Snake Bite, Wolf Bite, Ghoul Claws.
   */
  static findRider(activity){
    const saves = activity?.item?.system.activities?.getByType("save").filter(a => a.id !== activity.id) ?? [];
    /* 2014 monsters mark the rider "special", 2024 ones (Ghoul Claw) leave it as an action : any save on the attack's item rides it */
    return saves.find(a => a.activation?.type === "special") ?? saves[0] ?? null;
  }

  /**
   * An item whose only usable activities are one attack + its save rider(s) (Giant Spider Bite, Ghoul Claw)
   * goes straight to the attack instead of dnd5e's "which activity?" prompt : the rider is on the attack's card anyway.
   * @returns {Activity|null}  the attack to use, or null to let dnd5e prompt as normal
   */
  static fastForward(item, config = {}){
    if(config.chooseActivity) return null;
    if(!settings.value("rollItem") || !settings.value("rollItemDefault")) return null;
    const usable = item?.system?.activities?.filter(a => a.canUse) ?? [];
    const attacks = usable.filter(a => a.type === "attack");
    if(attacks.length !== 1 || usable.length < 2) return null;
    return usable.every(a => a === attacks[0] || a.type === "save") ? attacks[0] : null;
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

  /* Spread rays over the targets in order (your current targets unless given) : 4 rays, 2 targets -> A A B B.
     Given tokens keep their repeats : [A, A] -> both rays at A */
  static assignTargets(count, tokens){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const targets = tokens?.length ? tokens.flatMap(t => TargetsField.getDescriptors([t])) : TargetsField.getDescriptors();
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
   * @param {object} [options]
   * @param {string} [options.attackMode]     dnd5e attack mode for this attack ("thrown" uses up the weapon)
   * @param {boolean} [options.disadvantage]  roll this attack with disadvantage (long range...)
   * @returns {Promise<Roll[]|null>}  null if the attack was cancelled
   */
  static async rollRay(activity, event, index, target, { attackMode, disadvantage, mode } = {}){
    const config = {};
    if(Number.isFinite(target?.ac)) config.target = target.ac;
    if(attackMode) config.attackMode = attackMode;
    if(disadvantage) config.disadvantage = true;
    if(target?.token) config[module.id] = { target : target.token };
    const attack = await this.rollAttack(activity, event, config, mode);
    if(!attack) return null;
    const damage = await this.rollDamage(activity, attack);
    const graze = await masteries.grazeRolls(activity, attack, damage);
    for(const roll of [attack, ...damage]) roll.options[module.id] = { ray : index };
    for(const roll of graze) roll.options[module.id] = { ray : index, part : "graze" };
    return [attack, ...damage, ...graze];
  }

  static async rollRays(activity, count, { event, scaling = 0, attackMode, disadvantage, targets : tokens, mode } = {}){
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const targets = this.assignTargets(count, tokens);
    const rolls = [], rays = [];
    for(const [index, target] of targets.entries()){
      const config = this.attackConfig({ attackMode, disadvantage }, target ? TargetsField.resolve(target).token : null);
      const ray = await this.rollRay(activity, event, index, target, { ...config, mode });
      if(!ray) return;
      rolls.push(...ray);
      /* Each ray keeps its target, attack mode and disadvantage, so rerolls throw / shoot the same way */
      rays.push({
        target : target?.token ?? "",
        mode : ray[0].options.attackMode ?? config.attackMode ?? "",
        disadvantage : !!config.disadvantage,
      });
    }
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
    utility : "rollItemUtility",
  };

  static modeFor(activity, usage){
    /* Utility activities only have something to roll when they define a formula */
    if(activity?.type === "utility" && !activity.roll?.formula) return null;
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
        return void rollItem.attackAfterUse(activity, usage);
      case "save" :
      case "heal" :
      case "damage" :
      case "utility" :
        return void rollItem.usageCard(activity, results.message);
    }
  }

  /**
   * An attack used through dnd5e (sheet, hotbar...), after its use (so the cast level, and the ray count, are known).
   * With the Pick Targets setting you pick on the map first, the same as pickAndAttack : range shown, thrown beyond reach,
   * disadvantage at long range or for ranged attacks while threatened. Several rays / attacks can pick a target again.
   * Without a token on the scene being viewed there's nothing to pick from, so it rolls against your targets as usual.
   */
  static async attackAfterUse(activity, usage){
    const event = usage.event;
    const scaling = activity.item.getFlag("dnd5e", "scaling") ?? 0;
    const pick = settings.value("rollItemPick");
    const attacker = tokenOf(activity.item);
    if((pick === "off") || !canvas.ready || !attacker || (attacker.document.parent !== canvas.scene)){
      return this.rollActivity(activity, { event, scaling });
    }

    const count = this.countFor(activity);
    const picked = await pickAttack(activity.item, { activity, count, repeat : count > 1, clearTargets : pick === "always", used : true });
    if(!picked) return;
    const { targets, attackMode, disadvantage } = picked;
    /* Fewer picks than rays : the rays are spread over the picks (3 rays, A and B -> A A B) */
    return this.rollActivity(activity, { event, scaling, count : Math.max(count, targets.length), targets, attackMode, disadvantage });
  }

  /**
   * Using a Multiattack feature runs the whole Multiattack (MacroHelper.multiattack) with the Roll Item Multiattack
   * setting on : a pick and a card per weapon, instead of dnd5e's card for the feature.
   * @returns {boolean}
   */
  static isMultiattack(item, config = {}){
    if(config.chooseActivity || !settings.value("rollItem") || !settings.value("rollItemMultiattack")) return false;
    if(item?.type !== "feat") return false;
    const named = (item.identifier ?? item.system.identifier) === "multiattack" || /^multiattack\b/i.test(item.name ?? "");
    return named && getMultiattackPlan(item).length > 0;
  }

  /* ---------- Rolling ---------- */

  /* dnd5e attack roll, no dialog, no message */
  /* dnd5e attack roll, no dialog, no message. `mode` is the card's chosen advantage / disadvantage (chooseMode) :
     dnd5e combines it with everything else (long range, Poisoned, Vex...), advantage and disadvantage cancel out */
  static async rollAttack(activity, event, config = {}, mode = {}){
    const rollConfig = { ...config, event : this.keyEvent(event) };
    if(mode?.advantage) rollConfig.advantage = true;
    if(mode?.disadvantage) rollConfig.disadvantage = true;
    const [roll] = await activity.rollAttack(rollConfig, { configure : false }, { create : false }) ?? [];
    return roll ?? null;
  }

  /**
   * The Advantage setting :
   *   keys   : dnd5e's advantage / disadvantage keys held while rolling (Configure Controls, default Alt / Ctrl)
   *   prompt : ask Advantage / Normal / Disadvantage before rolling (after targets are picked)
   *   none   : neither, only what the rules give (long range, conditions, Vex...)
   * @returns {Promise<{ advantage? : boolean, disadvantage? : boolean }|null>}  null if the prompt was closed
   */
  static async chooseMode(activity, event){
    if(settings.value("rollItemAdvantage") !== "prompt") return {};
    const choice = await foundry.applications.api.DialogV2.wait({
      window : { title : activity?.item?.name ?? module.i18n("rollItem.mode.title"), icon : "fa-solid fa-dice-d20" },
      content : `<p>${module.i18n("rollItem.mode.hint")}</p>`,
      buttons : [
        { action : "advantage", label : "DND5E.Advantage", icon : "fa-solid fa-angles-up" },
        { action : "normal", label : "DND5E.Normal", icon : "fa-solid fa-dice-d20", default : true },
        { action : "disadvantage", label : "DND5E.Disadvantage", icon : "fa-solid fa-angles-down" },
      ],
      position : { width : 400 },
      rejectClose : false,
    });
    if(!choice) return null;
    return { advantage : choice === "advantage", disadvantage : choice === "disadvantage" };
  }

  /* A utility activity's own roll formula (dnd5e's "Roll" button), no dialog, no message */
  static async rollFormula(activity){
    if(!activity?.roll?.formula) return [];
    return await activity.rollFormula({}, { configure : false }, { create : false }) ?? [];
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
      /* Cleave's extra attack : masteries.onPreRollDamage takes a positive ability modifier off */
      ...(attack?.options?.[module.id]?.noMod ? { [module.id] : { noMod : true } } : {}),
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
    const usable = ["attack", "save", "damage", "heal", "utility"].flatMap(type => activities.getByType(type))
      .filter(a => (a.type !== "utility") || a.roll?.formula);
    if(!id) return usable[0] ?? null;
    return usable.find(a => a.id === id || a.name === id) ?? null;
  }

  /**
   * dnd5e reads advantage/disadvantage from an event using its keybindings (Configure Controls).
   * Macros may not have an event, so fall back to what is held down right now.
   */
  static keyEvent(event){
    if(settings.value("rollItemAdvantage") !== "keys") return undefined;
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
    masteries.register();
    Hooks.on("dnd5e.preUseActivity", rollItem.onPreUse);
    Hooks.on("dnd5e.postUseActivity", rollItem.onPostUse);

    /* Attack + save rider items skip dnd5e's activity choice (sheet, hotbar, anything calling item.use) */
    patch.wrap("CONFIG.Item.documentClass.prototype.use", async function(wrapped, config = {}, dialog = {}, message = {}){
      /* Multiattack : the whole thing, your targets used as they are with Pick Targets "when you have none" */
      if(rollItem.isMultiattack(this, config)){
        return multiattack(this, { event : config.event, attack : { clearTargets : settings.value("rollItemPick") !== "empty" } });
      }
      const attack = rollItem.fastForward(this, config);
      if(!attack) return wrapped(config, dialog, message);
      const { chooseActivity, ...usage } = config;
      return attack.use(usage, dialog, message);
    });

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
  static async attackCard(activity, rolls, { scaling = 0, rays = [], rider = null, disadvantage = false } = {}){
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
        ability, ammunition, mastery, scaling, rays, rider, disadvantage,
        mode : attackMode,
      },
    };
    ChatMessage.implementation.applyMode(messageData, CONFIG.Dice.BasicRoll.getMessageMode());

    /* Damage after the attack : everything is already rolled, this only staggers what is shown, so a natural 20
       isn't given away by crit damage dice rolling alongside it. The card goes out with every roll but shows
       "Rolling..." (flags.reveal 0), the attack dice play and the attack shows (1), then the damage dice and the
       damage (2). Dice So Nice's own animation of the card is skipped : the dice are played here, in order. */
    const { DamageRoll } = CONFIG.Dice;
    const attacks = rolls.filter(r => !(r instanceof DamageRoll));
    const damage = rolls.filter(r => r instanceof DamageRoll);
    const staged = settings.value("rollItemStaged") && attacks.length && damage.length;
    if(!staged) return await ChatMessage.implementation.create(messageData);

    messageData.flags = { [module.id] : { reveal : 0 } };
    if(game.dice3d) messageData.flags["dice-so-nice"] = { skip : true };
    const message = await ChatMessage.implementation.create(messageData);
    if(!message) return message;

    try {
      await this.showDice(attacks, message);
      await message.setFlag(module.id, "reveal", 1);
      await this.showDice(damage, message);
    }
    finally {
      await message.setFlag(module.id, "reveal", 2);
    }
    return message;
  }

  /* How much of a staged attack card can be shown : 0 nothing yet, 1 the attack, 2 everything.
     A card left half revealed (its roller disconnected) shows everything after 30 seconds. */
  static revealOf(message){
    const reveal = message?.getFlag(module.id, "reveal");
    if(!Number.isInteger(reveal) || (reveal >= 2)) return 2;
    if((Date.now() - (message.timestamp ?? 0)) > 30000) return 2;
    return reveal;
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

    /* Utility : its roll formula (dnd5e's "Roll" button) */
    const formula = await this.rollFormula(activity);
    for(const roll of formula) roll.options[module.id] = { part : "formula" };

    data.type = TYPES.save;
    data.rolls = [...(data.rolls ?? []), ...damage, ...formula];
    data.system.onSave = activity.damage?.onSave ?? null;
    data.system.buttons = (data.system.buttons ?? []).filter(b => !["rollDamage", "rollHealing", "rollFormula"].includes(b.action));
    if(formula.length) data.system.buttons.push({
      action : "rerollFormula",
      icon : "fa-solid fa-dice",
      label : { value : "rollItem.reroll.formula" },
    });
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

    /* Healing that can only land on yourself (Second Wind) : applied straight away, no tray */
    const selfHeal = isHeal && damage.length && (activity.target?.affects?.type === "self") && !!activity.actor;
    if(selfHeal) foundry.utils.setProperty(data, `flags.${module.id}.selfHeal`, true);

    log.debug("Usage card", activity.item.name, { data, damage });
    const message = await ChatMessage.implementation.create(data);
    if(selfHeal && message) await this.applyToSelf(activity.actor, damage, message);
    return message;
  }

  /* Same call dnd5e's tray makes, one entry per healing / damage type */
  static async applyToSelf(actor, rolls, message){
    const damages = dnd5e.dice.aggregateDamageRolls(rolls, { respectProperties : true }).map(roll => ({
      properties : new Set(roll.options.properties ?? []),
      type : roll.options.type,
      value : Math.max(0, roll.total),
    }));
    await actor.applyDamage(damages, { isDelta : true, origin : message });
  }
}
