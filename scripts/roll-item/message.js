import { module } from '../module.js';
import { rollItem } from './roll-item.js';
import { masteries } from './masteries.js';
import { features } from './features.js';
import { maneuvers } from './maneuvers.js';

/* Declared in module.json documentTypes.ChatMessage, Foundry prefixes them with the module id */
export const TYPES = {
  attack : `${module.id}.rollItem`,
  save : `${module.id}.save`,
};

export function registerMessages(){
  const { AttackMessageData, UsageMessageData } = dnd5e.dataModels.chatMessage;
  const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
  const { DamageRoll, aggregateDamageRolls } = dnd5e.dice;

  /* Shared markup for damage boxes, one per damage type : {{> "macro-helper.damage-rows" damage }} */
  foundry.applications.handlebars.loadTemplates({
    [`${module.id}.damage-rows`] : `${module.path}/templates/damage-rows.hbs`,
    [`${module.id}.mastery`] : `${module.path}/templates/mastery.hbs`,
    [`${module.id}.savage`] : `${module.path}/templates/savage.hbs`,
  });

  /* Does an attack roll hit this AC : crits always, fumbles never, no AC known counts as a hit */
  const hitsAC = (roll, ac) => {
    if(!roll) return false;
    if(roll.isCritical) return true;
    if(roll.isFumble) return false;
    return !Number.isFinite(ac) || (roll.total >= ac);
  };

  /**
   * Damage for display, split by damage type (1d8 slashing + 1d6 fire = two boxes), since targets can resist one and not the other.
   * The trays apply per type as well : they hand dnd5e one entry per type, which applies resistances per type.
   * Same breakdown data as dnd5e's DamageMessageData#_prepareContext.
   */
  const damageContext = (message, rolls) => {
    const isPrivate = !message.isContentVisible;
    const total = rolls.reduce((total, roll) => total + Math.max(0, roll.total), 0);
    const showTray = (game.user.isGM || dnd5e.settings.allowPlayerDamageTray) && !isPrivate;

    /* Hidden cards show one "?" box, the number of boxes would give the types away */
    if(isPrivate) return { isPrivate, total, showTray, types : [{ total : "?", isPrivate }] };

    const types = aggregateDamageRolls(rolls).map(roll => {
      const part = roll.aggregateTerms();
      const config = CONFIG.DND5E.damageTypes[part.type] ?? CONFIG.DND5E.healingTypes[part.type] ?? null;
      part.config = config;
      part.label = config?.labelShort ?? config?.label ?? "";
      return {
        type : part.type,
        label : config?.label ? game.i18n.localize(config.label) : "",
        icon : config?.icon ?? "",
        total : Math.max(0, roll.total),
        parts : [part],
      };
    });

    return { isPrivate, total, showTray, types };
  };

  /**
   * Swap rolls in once Dice So Nice has finished showing them, so the card never shows a result early.
   * @param {ChatMessage5e} message
   * @param {object} changes
   * @param {Roll[]} changes.rolls   the full new rolls array
   * @param {Roll[]} changes.shown   the rolls that are new and should be animated
   * @param {object} [changes.system]
   */
  const replaceRolls = async (message, { rolls, shown, system = {} }) => {
    await rollItem.showDice(shown, message);
    return message.update({ rolls : rolls.filter(Boolean).map(r => JSON.stringify(r)), system });
  };

  /* Rolls on our cards are tagged options[module.id] = { ray, part }, untagged rolls are ray 0 / "base" */
  const tagOf = roll => ({ ray : 0, part : "base", ...(roll.options?.[module.id] ?? {}) });
  const tag = (rolls, data) => { for(const roll of rolls) roll.options[module.id] = { ...tagOf(roll), ...data }; return rolls; };

  /**
   * The ActiveEffects an activity applies, for dnd5e's <effect-application> tray (which wants full uuids).
   * Activity effect links hold a uuid only for external effects, item effects are referenced by _id.
   */
  const effectDocs = activity => (activity?.applicableEffects ?? [])
    .map(e => e.uuid ? fromUuidSync(e.uuid, { strict : false }) : activity.item?.effects.get(e._id))
    .filter(Boolean);

  /* Same permission dnd5e uses for its effect tray */
  const canApplyEffects = message => message.isContentVisible && (game.user.isGM || dnd5e.settings.allowPlayerEffectsTray);

  /* dnd5e's compact roll box, used for non-damage rolls (utility formulas) */
  const ROLL_TEMPLATE = "systems/dnd5e/templates/chat/parts/roll-compact.hbs";

  /* Who damage lands on : the stored target, or the selected tokens if there was none. Only actors the user owns. */
  const targetActors = descriptor => {
    const actors = descriptor
      ? [TargetsField.resolve(descriptor).actor]
      : (canvas.tokens?.controlled ?? []).map(t => t.actor);
    return [...new Set(actors.filter(a => a?.isOwner))];
  };

  /* Same call dnd5e's damage tray makes : one entry per damage type, dnd5e applies resistances per type */
  const applyDamageRolls = async (message, actor, rolls) => {
    if(!rolls.length) return;
    const damages = aggregateDamageRolls(rolls, { respectProperties : true }).map(roll => ({
      properties : new Set(roll.options.properties ?? []),
      type : roll.options.type,
      value : Math.max(0, roll.total),
    }));
    await actor.applyDamage(damages, { isDelta : true, origin : message });
  };

  /**
   * dnd5e's damage tray, limited to one part of the card (dnd5e's own applies every damage roll on the message).
   *  data-part="base" | "save" | "graze"  the attack's damage, the on-hit save's damage (halved for targets that saved),
 *                             or the Graze mastery's damage for a miss
   *  data-ray="n"               one ray of a multi attack card
   * The parent fills `damages` and `chatMessage` when it connects; here `damages` always reads this part's rolls,
   * and for the save part `chatMessage.system` exposes the save's onSave + outcomes, which the parent uses for its save multiplier.
   */
  const DamageApplication = customElements.get("damage-application");
  class PartDamageApplication extends DamageApplication{
    static tagName = `${module.id}-damage`;

    #message = null;

    constructor(){
      super();
      Object.defineProperty(this, "damages", {
        configurable : true,
        get : ()=> this.partDamages(),
        set : ()=> {},
      });
      Object.defineProperty(this, "chatMessage", {
        configurable : true,
        get : ()=> this.#message && this.dataset.part === "save" ? this.#saveView(this.#message) : this.#message,
        set : message => this.#message = message ?? null,
      });
    }

    /* Savage Attacker : applying the first or the second roll keeps that one, the other goes away */
    async _onApplyDamage(event){
      await super._onApplyDamage(event);
      const message = this.#message;
      const part = this.dataset.part || "base";
      if(!message?.isOwner || !["base", "savage"].includes(part) || !message.system?.savageRolls) return;
      const ray = ("ray" in this.dataset) ? Number(this.dataset.ray) : null;
      if(!message.system.savageRolls(ray).length) return;
      await message.setFlag(module.id, `savage.${masteries.rayKey(ray)}`, part);
    }

    matches(roll){
      if(!(roll instanceof DamageRoll)) return false;
      const { ray, part } = tagOf(roll);
      if(("ray" in this.dataset) && ray !== Number(this.dataset.ray)) return false;
      return part === (this.dataset.part || "base");
    }

    partDamages(){
      const rolls = (this.#message?.rolls ?? []).filter(r => this.matches(r));
      return aggregateDamageRolls(rolls, { respectProperties : true }).map(roll => ({
        properties : new Set(roll.options.properties ?? []),
        type : roll.options.type,
        value : Math.max(0, roll.total),
      }));
    }

    /* The message as the tray sees it : system.onSave is the rider's, system.origin.system.outcomes are the rider saves */
    #saveView(message){
      const system = new Proxy(message.system, {
        get : (target, key) => {
          if(key === "onSave") return target.rider?.onSave ?? null;
          if(key === "origin") return { system : { outcomes : target.outcomes } };
          return Reflect.get(target, key, target);
        },
      });
      return new Proxy(message, {
        get : (target, key) => {
          if(key === "system") return system;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  if(!customElements.get(PartDamageApplication.tagName)) customElements.define(PartDamageApplication.tagName, PartDamageApplication);

  /* Let dnd5e collapse / remember our trays like its own */
  const trays = CONFIG.ChatMessage.documentClass.TRAY_TYPES;
  if(Array.isArray(trays) && !trays.includes(PartDamageApplication.tagName)) trays.push(PartDamageApplication.tagName);

  /**
   * Attack : dnd5e's attack message with the damage rolls folded in underneath.
   * The attack half renders exactly like dnd5e (header, properties, targets, compact roll box),
   * the damage half mirrors dnd5e's damage message (total, breakdown, damage tray).
   */
  class RollItemMessageData extends AttackMessageData{
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      template : `${module.path}/templates/roll-card.hbs`,
      actions : {
        rerollAttack : RollItemMessageData.#rerollAttack,
        rerollDamage : RollItemMessageData.#rerollDamage,
        rerollRay : RollItemMessageData.#rerollRay,
        applyHits : RollItemMessageData.#applyHits,
        rollRiderSave : RollItemMessageData.#rollRiderSave,
        rerollRiderDamage : RollItemMessageData.#rerollRiderDamage,
        useMastery : RollItemMessageData.#useMastery,
        rollSavage : RollItemMessageData.#rollSavage,
      },
    }, { inplace : false }));

    static defineSchema(){
      const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
      return {
        ...super.defineSchema(),
        /* Upcast levels, dnd5e's getAssociatedActivity({ scaled : true }) reads message.system.scaling */
        scaling : new NumberField({ integer : true, min : 0, initial : 0 }),
        /* Single attack made with disadvantage (long range...), so a reroll keeps it */
        disadvantage : new BooleanField({ initial : false }),
        /* One entry per attack roll when rolling more than one (Scorching Ray, cleave...) :
           target is a token uuid, mode the dnd5e attack mode ("thrown"...) and disadvantage it was made with, so rerolls match */
        rays : new ArrayField(new SchemaField({
          target : new StringField({ blank : true, initial : "" }),
          mode : new StringField({ blank : true, initial : "" }),
          disadvantage : new BooleanField({ initial : false }),
        })),
        /* On-hit save from the same item (Giant Spider's poison), captured when rolled */
        rider : new SchemaField({
          id : new StringField({ blank : true, initial : "" }),
          ability : new StringField({ blank : true, initial : "" }),
          dc : new NumberField({ integer : true, nullable : true, initial : null }),
          onSave : new StringField({ blank : true, nullable : true, initial : null }),
        }, { nullable : true, initial : null }),
      };
    }

    get canApplyDamage(){
      return true;
    }

    get isMulti(){
      return this.rays.length > 1;
    }

    get attackRoll(){
      return this.parent.rolls.find(r => !(r instanceof DamageRoll)) ?? null;
    }

    /* The attack's own damage */
    get damageRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "base");
    }

    /* Graze's damage for a miss (masteries.js) */
    get grazeRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "graze");
    }

    /* ---------- Weapon mastery (masteries.js) : ray is the attack's index on a multi card, null for a single attack ---------- */

    attackOf(ray){
      return Number.isInteger(ray) ? this.rayAttack(ray) : this.attackRoll;
    }

    /* The mastery the attack used, as dnd5e chose it (only for actors who have mastered the weapon) */
    masteryOf(ray){
      return (Number.isInteger(ray) ? this.attackOf(ray)?.options?.mastery : this.mastery) || null;
    }

    targetsOf(ray){
      return Number.isInteger(ray) ? [this.rayTarget(ray)].filter(Boolean) : this.targets;
    }

    /* Tokens the attack hit, from the card's targets */
    hitTargets(ray){
      const attack = this.attackOf(ray);
      return this.targetsOf(ray).filter(t => hitsAC(attack, t.ac)).map(t => TargetsField.resolve(t).token).filter(Boolean);
    }

    masteryUsed(ray){
      return !!this.parent.getFlag(module.id, `mastery.${masteries.rayKey(ray)}`);
    }

    /* The mastery part of the card for one attack : Graze's damage on a miss, or the button for a hit */
    masteryContext(ray){
      const key = this.masteryOf(ray);
      if(!key || !masteries.enabled() || !this.parent.isContentVisible) return null;
      const attack = this.attackOf(ray);
      const targets = this.targetsOf(ray);
      const hits = targets.filter(t => hitsAC(attack, t.ac));
      const missed = targets.length > hits.length;

      const grazeRolls = Number.isInteger(ray) ? this.rayDamage(ray, "graze") : this.grazeRolls;
      const graze = (grazeRolls.length && (missed || !targets.length))
        ? { ...damageContext(this.parent, grazeRolls), showTray : this.canApply, onMiss : !targets.length }
        : null;

      /* Cleave's own extra attack can't Cleave again (once per turn, even out of combat where turns aren't tracked) */
      const isCleave = !!attack?.options?.[module.id]?.noMod;
      const canUse = this.parent.isOwner && masteries.ACTIONS.includes(key) && !((key === "cleave") && isCleave);
      const action = (canUse && hits.length) ? {
        label : masteries.buttonLabel(key, this.parent.getAssociatedActor(), attack),
        used : this.masteryUsed(ray),
      } : null;
      if(!graze && !action) return null;

      return {
        key, graze, action,
        label : masteries.label(key),
        icon : masteries.ICONS[key] ?? "fa-star",
        ray : Number.isInteger(ray) ? ray : "",
        hasRay : Number.isInteger(ray),
      };
    }

    /* ---------- Savage Attacker (features.js) ---------- */

    savageRolls(ray){
      if(Number.isInteger(ray)) return this.rayDamage(ray, "savage");
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "savage");
    }

    /* Which roll was applied : "base", "savage", or null while both are on offer */
    savageChoice(ray){
      return this.parent.getFlag(module.id, `savage.${masteries.rayKey(ray)}`) ?? null;
    }

    /* The second roll and its tray, or the button to roll it (on an attack that hit, for its roller) */
    savageContext(ray){
      if(!features.savageEnabled() || !this.parent.isContentVisible) return null;
      const rolls = this.savageRolls(ray);
      const choice = this.savageChoice(ray);
      const base = { label : module.i18n("rollItem.savage.label"), ray : Number.isInteger(ray) ? ray : "", hasRay : Number.isInteger(ray) };

      if(rolls.length){
        if(choice === "base") return null;
        return { ...base, damage : { ...damageContext(this.parent, rolls), showTray : this.canApply }, chosen : choice === "savage" };
      }

      const attack = this.attackOf(ray);
      const targets = this.targetsOf(ray);
      const hit = targets.length ? targets.some(t => hitsAC(attack, t.ac)) : rollItem.isHit(attack);
      const hasDamage = Number.isInteger(ray) ? this.rayDamage(ray).length : this.damageRolls.length;
      if(!hit || !hasDamage || !features.canSavage(this.parent, this.parent.getAssociatedActivity())) return null;
      return { ...base, button : true };
    }

    /* ---------- Rider (on-hit save) ---------- */

    get riderRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll && tagOf(r).part === "save");
    }

    get riderActivity(){
      if(!this.rider?.id) return null;
      return this.parent.getAssociatedItem({ scaled : true })?.system.activities?.get(this.rider.id) ?? null;
    }

    /* Save results rolled from this card's save button, by token uuid (same as dnd5e's usage card) */
    get outcomes(){
      const outcomes = new Map();
      for(const message of this.parent.getAssociatedRolls("save")){
        const [roll] = message.rolls;
        if(!(roll instanceof CONFIG.Dice.D20Roll)) continue;
        const uuid = message.getAssociatedToken()?.uuid;
        if(!uuid) continue;
        if(roll.isSuccess || message.system.forceSuccess) outcomes.set(uuid, "success");
        else if(roll.isFailure) outcomes.set(uuid, "failure");
      }
      return outcomes;
    }

    /* With dnd5e's "Chat Card Summary" on, save results fold into this card instead of posting separately */
    get rendersSummaries(){
      return !!this.rider?.id;
    }

    /* ---------- Rays ---------- */

    rayOf(roll){
      return tagOf(roll).ray;
    }

    rayRolls(index){
      return this.parent.rolls.filter(r => this.rayOf(r) === index);
    }

    rayTarget(index){
      const uuid = this.rays[index]?.target;
      return uuid ? this.targets.find(t => t.token === uuid) ?? null : null;
    }

    /* Rebuild the rolls array in ray order, replacing the rays given */
    withRays(replaced){
      return this.rays.flatMap((_, i) => replaced.has(i) ? replaced.get(i) : this.rayRolls(i));
    }

    rayAttack(index){
      return this.rayRolls(index).find(r => !(r instanceof DamageRoll)) ?? null;
    }

    /* A ray's own damage ("base"), or its Graze damage ("graze") */
    rayDamage(index, part = "base"){
      return this.rayRolls(index).filter(r => r instanceof DamageRoll && tagOf(r).part === part);
    }

    /* Who a ray's damage lands on : its target, or the selected tokens if it had none */
    rayActors(index){
      return targetActors(this.rayTarget(index));
    }

    get canApply(){
      return this.parent.isContentVisible && (game.user.isGM || dnd5e.settings.allowPlayerDamageTray);
    }

    async applyRolls(actor, rolls){
      return applyDamageRolls(this.parent, actor, rolls);
    }

    async _prepareContext(options){
      const context = await super._prepareContext(options);
      const rolls = this.parent.rolls;
      const rendered = context.rolls;


      /* Only whoever can update the message (roller / GM) can reroll it */
      const activity = this.parent.getAssociatedActivity();
      const canReroll = this.parent.isOwner && this.parent.isContentVisible && !!activity;
      context.buttons = canReroll ? { damage : !!activity.damage?.parts?.length } : null;

      /* Effects the attack applies (Guiding Bolt, Ray of Frost), normally on dnd5e's usage card which we replace.
         Effects the rider also carries (2024 Ghoul's Paralyzed) only apply on a failed save, they show in the save section. */
      context.effects = [];
      if(canApplyEffects(this.parent)){
        const riderEffects = new Set(effectDocs(this.riderActivity).map(e => e.id));
        context.effects = effectDocs(this.parent.getAssociatedActivity({ scaled : true })).filter(e => !riderEffects.has(e.id));
      }

      if(this.isMulti){
        /* dnd5e's target pills judge every target against the first roll, the rows show each ray's own target instead */
        context.targets = [];
        context.rolls = [];
        const visible = this.parent.isContentVisible;
        const canApply = this.canApply;

        /* Same visibility rules dnd5e uses for its target pills */
        const visibility = dnd5e.settings.attackRollVisibility;
        const showAC = game.user.isGM || (visibility === "all");
        const showResult = game.user.isGM || (visibility !== "none");

        context.rays = this.rays.map((_, i) => {
          const attackIndex = rolls.findIndex(r => !(r instanceof DamageRoll) && this.rayOf(r) === i);
          const attack = rolls[attackIndex];
          const damage = this.rayDamage(i);
          const target = visible ? this.rayTarget(i) : null;
          return {
            index : i,
            number : i + 1,
            canReroll,
            attack : rendered[attackIndex] ?? "",
            /* Hidden cards must not give away hits through the miss styling */
            hit : visible ? rollItem.isHit(attack) : true,
            target : target ? {
              ...target,
              hasAC : target.ac !== null,
              isMiss : !rollItem.isHit(attack),
              showAC, showResult,
            } : null,
            damage : (damage.length || !visible) ? damageContext(this.parent, damage) : null,
            showTray : canApply && damage.length > 0,
            mastery : this.masteryContext(i),
            savage : this.savageContext(i),
          };
        });
        /* Savage Attacker's second roll was the one applied : the first goes away */
        for(const ray of context.rays) if(this.savageChoice(ray.index) === "savage"){ ray.damage = null; ray.showTray = false; }
        context.applyHits = canApply && context.rays.some(r => (r.hit && r.showTray) || r.mastery?.graze);
        return this._hideUnrevealed(context);
      }

      /* Single attack : super renders every roll as a compact box, keep only the attack there */
      context.rolls = rendered.filter((_, i) => !(rolls[i] instanceof DamageRoll));
      const damage = this.damageRolls;
      if(damage.length) context.damage = { ...damageContext(this.parent, damage), showTray : this.canApply };

      context.mastery = this.masteryContext(null);
      context.savage = this.savageContext(null);
      if(this.savageChoice(null) === "savage") context.damage = null;

      if(this.rider?.id) context.rider = await this._prepareRiderContext(options);
      if(context.buttons && context.rider) context.buttons.rider = context.rider.hasDamage;

      return this._hideUnrevealed(context);
    }

    /**
     * Damage after the attack (rollItem.attackCard) : leave out what hasn't been rolled on screen yet.
     *   reveal 0 : nothing but "Rolling..." (no attack totals, no hit / miss on the targets)
     *   reveal 1 : the attack(s), not the damage, masteries, rider or buttons
     */
    _hideUnrevealed(context){
      const reveal = rollItem.revealOf(this.parent);
      if(reveal >= 2) return context;

      context.pending = true;
      context.damage = null;
      context.mastery = null;
      context.savage = null;
      context.rider = null;
      context.applyHits = false;
      context.buttons = null;
      context.effects = [];
      context.rays = (context.rays ?? []).map(ray => ({
        ...ray, damage : null, showTray : false, mastery : null, savage : null, canReroll : false,
        ...(reveal < 1 ? { attack : "", hit : true, target : ray.target ? { ...ray.target, showResult : false } : null } : {}),
      }));
      if(reveal < 1){
        context.rolls = [];
        context.targets = (context.targets ?? []).map(t => ({ ...t, showResult : false }));
      }
      return context;
    }

    async _prepareRiderContext(options){
      const save = this.riderActivity;
      const visible = this.parent.isContentVisible;
      const rolls = this.riderRolls;

      const ability = CONFIG.DND5E.abilities[this.rider.ability]?.label ?? "";
      const dc = this.rider.dc;
      const label = (this.parent.shouldDisplayChallenge && Number.isFinite(dc))
        ? game.i18n.format("DND5E.SavingThrowDC", { ability, dc })
        : game.i18n.format("DND5E.SavePromptTitle", { ability });

      /* Save results as lines on this card (dnd5e "Chat Card Summary") */
      let summaries = [];
      if(game.settings.get("dnd5e", "chatCardSummary")){
        summaries = (await Promise.all(this.parent.getAssociatedRolls("save")
          .filter(m => m.visible)
          .map(async m => ({ html : await m.system.render({ summary : true }), id : m.id, token : m.getAssociatedToken() }))))
          .filter(s => s.html);
      }

      return {
        name : save?.name || game.i18n.localize("DND5E.SavingThrow"),
        label,
        /* Faded when the attack is known to have missed, the GM can still use it */
        miss : visible && !rollItem.isHit(this.attackRoll),
        hasDamage : rolls.length > 0,
        damage : rolls.length ? { ...damageContext(this.parent, rolls), showTray : this.canApply } : null,
        summaries,
        effects : canApplyEffects(this.parent) ? effectDocs(save) : [],
      };
    }

    /* ---------- Actions ---------- */

    /** @this {RollItemMessageData} */
    static async #rerollAttack(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const mode = await rollItem.chooseMode(activity, event);
      if(!mode) return target.disabled = false;

      /* Multi : every ray again, damage follows the new hits */
      if(this.isMulti){
        const replaced = new Map();
        for(const i of this.rays.keys()){
          const ray = await rollItem.rollRay(activity, event, i, this.rayTarget(i), { attackMode : this.rays[i].mode || undefined, disadvantage : this.rays[i].disadvantage, mode });
          if(!ray) return target.disabled = false;
          replaced.set(i, ray);
        }
        return replaceRolls(this.parent, { rolls : this.withRays(replaced), shown : [...replaced.values()].flat() });
      }

      const attack = await rollItem.rollAttack(activity, event, {
        ability : this.ability ?? undefined,
        attackMode : this.mode ?? undefined,
        ...(this.disadvantage ? { disadvantage : true } : {}),
        ...(this.targets.length === 1 ? { [module.id] : { target : this.targets[0].token } } : {}),
      }, mode);
      if(!attack) return target.disabled = false;

      /* Cleave's extra attack stays one, and Graze follows the new attack */
      if(this.attackRoll?.options?.[module.id]?.noMod) attack.options[module.id] = { ...(attack.options[module.id] ?? {}), noMod : true };
      const graze = tag(await masteries.grazeRolls(activity, attack, this.damageRolls), { part : "graze" });

      const { ability, ammunition, attackMode, mastery } = attack.options;
      await replaceRolls(this.parent, {
        rolls : [attack, ...this.damageRolls, ...graze, ...this.riderRolls],
        shown : [attack],
        system : { ability, ammunition, mastery, mode : attackMode },
      });
    }

    /** @this {RollItemMessageData} */
    static async #rerollDamage(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      /* Multi : new damage for every ray, attacks stay */
      if(this.isMulti){
        const replaced = new Map(), shown = [];
        for(const i of this.rays.keys()){
          const attack = this.rayAttack(i);
          const damage = tag(await rollItem.rollDamage(activity, attack), { ray : i });
          replaced.set(i, [attack, ...damage, ...this.rayDamage(i, "graze"), ...this.rayDamage(i, "savage")]);
          shown.push(...damage);
        }
        if(!shown.length) return target.disabled = false;
        return replaceRolls(this.parent, { rolls : this.withRays(replaced), shown });
      }

      const damage = await rollItem.rollDamage(activity, this.attackRoll);
      if(!damage.length) return target.disabled = false;

      await replaceRolls(this.parent, { rolls : [this.attackRoll, ...damage, ...this.grazeRolls, ...this.savageRolls(null), ...this.riderRolls], shown : damage });
    }

    /** @this {RollItemMessageData} */
    static async #rerollRiderDamage(event, target){
      const save = this.riderActivity;
      if(!save) return;
      target.disabled = true;

      const damage = tag(await rollItem.rollDamage(save, null), { part : "save" });
      if(!damage.length) return target.disabled = false;
      await replaceRolls(this.parent, { rolls : [this.attackRoll, ...this.damageRolls, ...this.grazeRolls, ...this.savageRolls(null), ...damage], shown : damage });
    }

    /**
     * Same as dnd5e's save button : each clicking user rolls for the targets they own (the GM for NPCs),
     * falling back to their selected tokens, then their character. Results link back to this card.
     * @this {RollItemMessageData}
     */
    static async #rollRiderSave(event, target){
      const save = this.riderActivity;
      if(!save) return;

      let tokens = this.targets.map(t => TargetsField.resolve(t).token).filter(t => t?.actor?.isOwner);
      if(!tokens.length) tokens = (canvas.tokens?.controlled ?? []).filter(t => t.actor?.isOwner);
      const rollers = tokens.length
        ? tokens.map(token => ({ actor : token.actor, token }))
        : (game.user.character ? [{ actor : game.user.character }] : []);
      if(!rollers.length) return ui.notifications.warn("DND5E.ActionWarningNoToken", { localize : true });

      const bonus = CONFIG.Dice.BasicRoll.replaceFormulaData(save.save.bonus ?? "", save.getRollData(), { missing : 0 });
      const bonusData = CONFIG.Dice.BasicRoll.constructParts({ activityBonus : bonus });

      target.disabled = true;
      try {
        for(const { actor, token } of rollers){
          const speaker = ChatMessage.implementation.getSpeaker({ actor, scene : canvas.scene, token : token?.document });
          const rollData = {
            event,
            ability : this.rider.ability || save.save.ability.first(),
            target : Number.isFinite(this.rider.dc) ? this.rider.dc : save.save.dc.value,
          };
          if(bonusData.parts.length) rollData.rolls = [bonusData];
          await actor.rollSavingThrow(rollData, {}, { data : { speaker, system : { ...save.messageSources, origin : this.parent.id } } });
        }
      } finally {
        target.disabled = false;
      }
    }

    /* Savage Attacker's button : data-ray is the attack on a multi card, empty for a single attack */
    /** @this {RollItemMessageData} */
    static async #rollSavage(event, target){
      const ray = (target.dataset.ray === "" || target.dataset.ray === undefined) ? null : Number(target.dataset.ray);
      target.disabled = true;
      try { await features.savage(this.parent, ray); }
      catch(error){
        console.error("Macro Helper | Savage Attacker", error);
        ui.notifications.warn(error.message);
        target.disabled = false;
      }
    }

    /* The mastery button : data-ray is the attack on a multi card, empty for a single attack */
    /** @this {RollItemMessageData} */
    static async #useMastery(event, target){
      const ray = (target.dataset.ray === "" || target.dataset.ray === undefined) ? null : Number(target.dataset.ray);
      target.disabled = true;
      try { await masteries.use(this.parent, ray, event); }
      catch(error){
        console.error("Macro Helper | mastery", error);
        ui.notifications.warn(error.message);
      }
      finally { target.disabled = this.masteryUsed(ray); }
    }

    /** @this {RollItemMessageData} */
    static async #rerollRay(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      const index = Number(target.dataset.ray);
      if(!activity || !this.rays[index]) return;
      target.disabled = true;

      const mode = await rollItem.chooseMode(activity, event);
      if(!mode) return target.disabled = false;
      const ray = await rollItem.rollRay(activity, event, index, this.rayTarget(index), { attackMode : this.rays[index].mode || undefined, disadvantage : this.rays[index].disadvantage, mode });
      if(!ray) return target.disabled = false;
      await replaceRolls(this.parent, { rolls : this.withRays(new Map([[index, ray]])), shown : ray });
    }

    /* Every ray that hit onto its own target, rays without a target go to the selected tokens. Misses with Graze deal that. */
    /** @this {RollItemMessageData} */
    static async #applyHits(event, target){
      const byActor = new Map();
      for(const i of this.rays.keys()){
        const hit = rollItem.isHit(this.rayAttack(i));
        let rolls = hit ? this.rayDamage(i) : (masteries.enabled() ? this.rayDamage(i, "graze") : []);
        const savage = hit ? this.rayDamage(i, "savage") : [];
        if(savage.length){
          const total = list => list.reduce((sum, r) => sum + r.total, 0);
          let choice = this.savageChoice(i);
          if(!choice){
            choice = (total(savage) > total(rolls)) ? "savage" : "base";
            if(this.parent.isOwner) await this.parent.setFlag(module.id, `savage.${i}`, choice);
          }
          if(choice === "savage") rolls = savage;
        }
        if(!rolls.length) continue;
        for(const actor of this.rayActors(i)){
          byActor.set(actor, [...(byActor.get(actor) ?? []), ...rolls]);
        }
      }
      if(!byActor.size) return ui.notifications.warn("rollItem.apply.noTarget", { localize : true });

      target.disabled = true;
      for(const [actor, rolls] of byActor) await this.applyRolls(actor, rolls);
      target.disabled = false;
    }
  }

  /**
   * Save / heal / damage : dnd5e's usage card (header, description, targets, save buttons, save summaries, effects)
   * with the damage (or healing) already rolled onto it, and a damage tray that knows who saved.
   * Damage-only activities can roll several instances (Magic Missile darts), each with its own target and tray.
   */
  class RollItemSaveData extends UsageMessageData{
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      template : `${module.path}/templates/save-card.hbs`,
      actions : {
        rerollDamage : RollItemSaveData.#rerollDamage,
        rerollRay : RollItemSaveData.#rerollRay,
        applyRays : RollItemSaveData.#applyRays,
        rerollFormula : RollItemSaveData.#rerollFormula,
        shove : RollItemSaveData.#shove,
      },
    }, { inplace : false }));

    static defineSchema(){
      const { ArrayField, SchemaField, StringField } = foundry.data.fields;
      return {
        ...super.defineSchema(),
        onSave : new StringField({ blank : false, initial : null, nullable : true, required : false }),
        /* One entry per damage instance when rolling more than one (Magic Missile), target is a token uuid */
        rays : new ArrayField(new SchemaField({
          target : new StringField({ blank : true, initial : "" }),
        })),
      };
    }

    get canApplyDamage(){
      return true;
    }

    /**
     * dnd5e's damage tray reads save outcomes from message.system.origin.system.outcomes.
     * On a normal usage the damage is its own message whose origin is the usage card; here they are the same card.
     */
    get origin(){
      return game.messages.has(this.parent.id) ? this.parent : null;
    }

    get isMulti(){
      return this.rays.length > 1;
    }

    get damageRolls(){
      return this.parent.rolls.filter(r => r instanceof DamageRoll);
    }

    rayDamage(index){
      return this.damageRolls.filter(r => tagOf(r).ray === index);
    }

    /* A utility activity's roll formula, rolled onto the card */
    get formulaRolls(){
      return this.parent.rolls.filter(r => tagOf(r).part === "formula");
    }

    async _prepareFormulaContext(){
      const [roll] = this.formulaRolls;
      if(!roll) return null;
      const activity = this.parent.getAssociatedActivity();
      return {
        label : activity?.roll?.name || game.i18n.localize("DND5E.Roll"),
        html : await roll.render({ template : ROLL_TEMPLATE, isPrivate : !this.parent.isContentVisible }),
      };
    }

    rayTarget(index){
      const uuid = this.rays[index]?.target;
      return uuid ? this.targets.find(t => t.token === uuid) ?? null : null;
    }

    async _prepareContext(options){
      const context = await super._prepareContext(options);
      if(context.content) return context;

      context.formula = await this._prepareFormulaContext();

      if(this.isMulti){
        const visible = this.parent.isContentVisible;
        const canReroll = this.parent.isOwner && visible;
        const canApply = visible && (game.user.isGM || dnd5e.settings.allowPlayerDamageTray);
        context.rays = this.rays.map((_, i) => {
          const damage = this.rayDamage(i);
          return {
            index : i,
            number : i + 1,
            canReroll,
            target : visible ? this.rayTarget(i) : null,
            damage : damageContext(this.parent, damage),
            showTray : canApply && damage.length > 0,
          };
        });
        return context;
      }

      const damage = this.damageRolls;
      if(damage.length) context.damage = damageContext(this.parent, damage);

      /* Shove : Prone or Push 5 ft for each target that failed its save */
      context.shove = maneuvers.shoveContext(this.parent);

      /* Self-only healing (Second Wind) was applied when rolled : no tray, just who it went to */
      if(context.damage && this.parent.getFlag(module.id, "selfHeal")){
        context.damage.showTray = false;
        context.selfApplied = this.parent.getAssociatedActor()?.name ?? "";
      }

      return context;
    }

    /* Re-roll one instance's damage, tagged with its index */
    async _rollRay(activity, index){
      return tag(await rollItem.rollDamage(activity, null), { ray : index });
    }

    /** @this {RollItemSaveData} */
    static async #rerollDamage(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const keep = this.parent.rolls.filter(r => !(r instanceof DamageRoll));
      const damage = [];
      if(this.isMulti) for(const i of this.rays.keys()) damage.push(...await this._rollRay(activity, i));
      else damage.push(...await rollItem.rollDamage(activity, null));
      if(!damage.length) return target.disabled = false;

      await replaceRolls(this.parent, { rolls : [...keep, ...damage], shown : damage });
    }

    /** @this {RollItemSaveData} */
    static async #rerollRay(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      const index = Number(target.dataset.ray);
      if(!activity || !this.rays[index]) return;
      target.disabled = true;

      const damage = await this._rollRay(activity, index);
      if(!damage.length) return target.disabled = false;
      const rolls = this.parent.rolls.filter(r => !(r instanceof DamageRoll) || tagOf(r).ray !== index);
      await replaceRolls(this.parent, { rolls : [...rolls, ...damage], shown : damage });
    }

    /** @this {RollItemSaveData} */
    static async #rerollFormula(event, target){
      const activity = this.parent.getAssociatedActivity({ scaled : true });
      if(!activity) return;
      target.disabled = true;

      const rolls = tag(await rollItem.rollFormula(activity), { part : "formula" });
      if(!rolls.length) return target.disabled = false;
      const keep = this.parent.rolls.filter(r => tagOf(r).part !== "formula");
      await replaceRolls(this.parent, { rolls : [...keep, ...rolls], shown : rolls });
    }

    /* Shove's choice for one target : data-target is its token uuid, data-choice "prone" or "push" */
    /** @this {RollItemSaveData} */
    static async #shove(event, target){
      const { target : uuid, choice } = target.dataset;
      target.disabled = true;
      try { await maneuvers.shove(this.parent, uuid, choice); }
      catch(error){
        console.error("Macro Helper | Shove", error);
        ui.notifications.warn(error.message);
        target.disabled = false;
      }
    }

    /* Each instance onto its own target, instances without a target go to the selected tokens */
    /** @this {RollItemSaveData} */
    static async #applyRays(event, target){
      const byActor = new Map();
      for(const i of this.rays.keys()){
        for(const actor of targetActors(this.rayTarget(i))){
          byActor.set(actor, [...(byActor.get(actor) ?? []), ...this.rayDamage(i)]);
        }
      }
      if(!byActor.size) return ui.notifications.warn("rollItem.apply.noTarget", { localize : true });

      target.disabled = true;
      for(const [actor, rolls] of byActor) await applyDamageRolls(this.parent, actor, rolls);
      target.disabled = false;
    }
  }

  CONFIG.ChatMessage.dataModels[TYPES.attack] = RollItemMessageData;
  CONFIG.ChatMessage.dataModels[TYPES.save] = RollItemSaveData;

  /* Our cards grow after they're posted (damage after the attack, rerolls, save results) : keep the chat log at the
     bottom if it was there, once the new card is in place. Someone scrolled up reading older messages stays put. */
  const ours = new Set(Object.values(TYPES));
  Hooks.on("renderChatMessageHTML", message => {
    if(!ours.has(message.type) || !ui.chat?.isAtBottom) return;
    requestAnimationFrame(()=> ui.chat.scrollBottom({ popout : true }));
  });
}
