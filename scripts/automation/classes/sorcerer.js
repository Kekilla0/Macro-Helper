import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, esc } from '../../helpers/utils.js';
import { usedThisTurn, markUsedThisTurn, itemEffectOn, effectsFrom, spellSlots, addSpellSlot } from '../../helpers/actors.js';
import { isClassSpell, spendUses, replaceItem } from '../../helpers/items.js';
import { bonusOnlyWhen } from '../bonus-only-when.js';
import { limits } from '../limits.js';
import { giveMode } from '../../roll-item/reasons.js';
import { rollModes } from '../roll-modes.js';
import { uses } from '../../uses.js';
import { actions } from '../actions.js';
import { restChoices } from '../rest-choices.js';
import { onDamage } from '../../roll-item/damage.js';
import { castingChoice, castingChoiceOf } from '../casting-choice.js';
import { saveRowToggle } from '../../roll-item/row-toggles.js';
import { rerollButton } from '../../roll-item/reroll-buttons.js';
import { extendDurations } from '../durations.js';
import { cantUseWhile } from '../use-rules.js';
import { pickFromCompendium } from '../compendiums.js';
import { spells } from '../spells.js';
import { chooseOne } from '../../helpers/creatures.js';
const log = logger.for(import.meta.url);

/**
 * Sorcerer, levels 1-2 (Classes setting). Changing a prepared spell on a level is Prepared Spells. Works from item
 * identifiers, whoever made them. Built from the legos : what's left here is each feature's own part.
 *
 *   Innate Sorcery : using it puts its effect on the Sorcerer at once (itemEffectOn : the item's effect, +1 spell save
 *                    DC, for a minute). While it's on, the Sorcerer's spell attack rolls (Sorcerer spells) have
 *                    advantage (a roll-modes rule : the pick map shows it too). Its +1 is to every spell's DC in dnd5e;
 *                    the spells that aren't Sorcerer spells (a species' or feat's) get it taken back off (bonusOnlyWhen).
 *   Metamagic      : castingChoice : casting a spell (any the Sorcerer has : 2024 Metamagic changes "spells you cast")
 *                    with options known and Sorcery Points to pay : which option (or none), shown on the card under the
 *                    spell's description, paid once the cast goes through. Distant : twice the range picked within
 *                    (Touch : 30 ft). Quickened : a Bonus Action (the Action Tracker's economy); not after a level 1+
 *                    spell this turn, and no level 1+ spell after it (Rule Limits). Subtle : no V, S, or M that isn't
 *                    consumed or costed. Twinned : one more target. Transmuted : the damage type chosen. Extended :
 *                    extendDurations (twice as long, 24 h at most, advantage on its Concentration saves). Careful /
 *                    Heightened : saveRowToggle on the save card (Careful : up to the CHA modifier succeed without
 *                    rolling, no damage where a success takes half; Heightened : one, its first save at disadvantage).
 *                    Empowered / Seeking : rerollButton on the card after the roll (the lowest CHA-modifier damage
 *                    dice / a missed spell attack's d20). Gaining a Sorcerer level : one option replaced per level
 *                    (Rest Choices, addRestChoice count; from the Item compendiums, a copy of yours before dnd5e's own).
 *   Font of Magic  : using it opens a window : a spell slot into Sorcery Points (each level you have a slot of, with the
 *                    points it gives, never past the maximum), or Sorcery Points into a new slot (2024 : levels 1-5,
 *                    each from a Sorcerer level : 2 / 3 / 5 / 7 / 9, costing 2 / 3 / 5 / 6 / 7). A slot made goes on
 *                    top of that level's count (addSpellSlot, past its maximum); dnd5e's Long Rest sets every level
 *                    back to its maximum, so the slots made vanish then, as the rule says. Its own activities aren't used.
 */
export class sorcerer{
  static INNATE = "innate-sorcery";
  static FONT = "font-of-magic";
  /* Points into a slot (2024) : level -> Sorcery Points */
  static SLOT_COST = { 1 : 2, 2 : 3, 3 : 5, 4 : 6, 5 : 7 };
  /* The Sorcerer level a slot level can be made from (2024) */
  static SLOT_MIN_LEVEL = { 1 : 2, 2 : 3, 3 : 5, 4 : 7, 5 : 9 };
  /* Where the Sorcery Points are : Plutonium's "Sorcery Points" item, or dnd5e's Font of Magic */
  static POINTS = ["sorcery-points", "font-of-magic"];
  /* 2024 Metamagic options : their cost in Sorcery Points */
  static METAMAGIC = {
    "careful-spell" : 1, "distant-spell" : 1, "empowered-spell" : 1, "extended-spell" : 1, "heightened-spell" : 2,
    "quickened-spell" : 2, "seeking-spell" : 1, "subtle-spell" : 1, "transmuted-spell" : 1, "twinned-spell" : 1,
  };

  static enabled = settings.on("classRules");

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onInnate(activity, results));
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && (idOf(activity?.item) === this.INNATE)));
    rollModes.add("innate", config => this.innateMode(config));
    /* Innate Sorcery's DC : Sorcerer spells only (dnd5e's bonus is to every spell) */
    bonusOnlyWhen(this.INNATE, "system.bonuses.spell.dc", activity => this.isSorcererSpell(activity.item), { enabled : () => this.enabled() });
    /* Innate Sorcery's minute over : Foundry only marks it expired (it stops counting); the GM removes it */
    Hooks.on("updateActiveEffect", effect => {
      if(game.users.activeGM?.isSelf && effect?.duration?.expired && effect.getFlag?.(module.id, "innateSorcery")) effect.delete().catch(() => {});
    });
    this.registerMetamagic();
    uses.onItem("fontOfMagic", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.FONT) || !item.actor) return next();
      return this.font(item.actor, item);
    });
  }

  /* A spell cast as a Sorcerer spell (its class link) */
  static isSorcererSpell(item){
    return isClassSpell(item, "sorcerer");
  }

  /* ---------- Innate Sorcery ---------- */

  static innateOn(actor){
    /* Not disabled, not past its minute (Foundry marks it expired) */
    return effectsFrom(actor, e => e.getFlag(module.id, "innateSorcery") || (idOf(fromUuidSync(e.origin ?? "", { strict : false })) === this.INNATE)).length > 0;
  }

  /* Used : its effect on the Sorcerer (the item's, else +1 spell save DC), for a minute */
  static async onInnate(activity, results){
    const actor = activity?.actor;
    if(!this.enabled() || (idOf(activity?.item) !== this.INNATE) || !actor?.isOwner) return;
    const own = activity.getUsageToken?.()?.actor ?? actor;
    if(this.innateOn(own)) return;
    await itemEffectOn(activity.item, { on : own, copy : true,
      fallback : { changes : [{ key : "system.bonuses.spell.dc", type : "add", mode : 2, value : "1" }] },
      data : { showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2, duration : { value : 60, units : "seconds" },
        flags : { [module.id] : { innateSorcery : true } } } });
    await actions.autoApplied(results);
    log.debug("Innate Sorcery", own.name);
  }

  /* Its advantage : the Sorcerer's spell attacks with a Sorcerer spell */
  static innateMode(config){
    const activity = config?.subject, actor = activity?.actor;
    const roll = config?.rolls?.[0];
    if(!this.enabled() || !roll || !this.isSorcererSpell(activity?.item) || !this.innateOn(actor)) return;
    giveMode(roll, "advantage", module.i18n("classes.sorcerer.innate"));
  }

  /* ---------- Metamagic ---------- */

  static pointsOf(actor){
    return actor?.items?.find?.(i => this.POINTS.includes(idOf(i)) && i.system?.uses?.max) ?? null;
  }

  static pointsLeft(actor){
    return Number(this.pointsOf(actor)?.system?.uses?.value) || 0;
  }

  /* A Metamagic option's id from an item or index entry ("metamagic-quickened-spell", "quickened-spell"), else null */
  static metamagicId(thing){
    const id = String(thing?.system?.identifier || idOf(thing) || "").replace(/^metamagic-/, "");
    return this.METAMAGIC[id] ? id : null;
  }

  /* The options this Sorcerer knows : [{ id, item, cost }] */
  static optionsOf(actor){
    const out = [];
    for(const item of actor?.items ?? []){
      const id = this.metamagicId(item);
      if(id) out.push({ id, item, cost : this.METAMAGIC[id] });
    }
    return out;
  }

  static knows(actor, id){
    return this.optionsOf(actor).find(o => o.id === id) ?? null;
  }

  /* Empowered and Seeking are used after the roll (on the card, alongside another option); the rest when casting */
  static AFTER = ["empowered-spell", "seeking-spell"];
  static TRANSMUTABLE = ["acid", "cold", "fire", "lightning", "poison", "thunder"];

  /* The spell's damage types (all its damage activities) */
  static damageTypes(item){
    const types = new Set();
    for(const a of item?.system?.activities ?? []) for(const part of a.damage?.parts ?? []) for(const t of part.types ?? []) types.add(t);
    return types;
  }

  /* Does a cast-time option fit this spell ? */
  static fits(id, activity){
    const item = activity?.item;
    const save = [...(item?.system?.activities ?? [])].some(a => a.type === "save");
    const range = activity?.range?.override ? activity.range : (item?.system?.range ?? {});
    const duration = item?.system?.duration ?? {};
    switch(id){
      case "careful-spell" :
      case "heightened-spell" : return save;
      case "distant-spell" : return (range.units === "touch") || (Number(range.value) >= 5);
      case "extended-spell" : return !["inst", ""].includes(duration.units ?? "") && (Number(duration.value) > 0 || duration.units === "perm");
      case "quickened-spell" : return (activity?.activation?.type ?? "action") === "action";
      case "transmuted-spell" : return [...this.damageTypes(item)].some(t => this.TRANSMUTABLE.includes(t));
      /* 2024 : a spell a higher slot lets target an additional creature; its effective level goes up by 1 */
      case "twinned-spell" : return !!spells.upcastRule(item);
      default : return true;
    }
  }

  /* What an option changes on the use : the marks the casting rules read */
  static usageOf(id, activity){
    switch(id){
      case "distant-spell" : return { rangeMultiplier : 2 };
      case "quickened-spell" : return { economy : "bonus" };
      case "twinned-spell" : return { extraTargets : spells.upcastRule(activity?.item)?.per ?? 1 };
      case "subtle-spell" : {
        /* 2024 : no Verbal, Somatic or Material components, but a Material one that's consumed or has a cost */
        const m = activity?.item?.system?.materials ?? {};
        return { components : { v : false, s : false, ...((m.consumed || (Number(m.cost) > 0)) ? {} : { m : false }) } };
      }
      default : return {};
    }
  }

  /* Transmuted Spell : which type it becomes */
  static async chooseType(item){
    const from = [...this.damageTypes(item)].filter(t => this.TRANSMUTABLE.includes(t));
    return chooseOption({ title : item.name, icon : "fa-solid fa-shuffle", prompt : module.i18n("classes.sorcerer.transmutePrompt"),
      options : this.TRANSMUTABLE.filter(t => !from.includes(t) || (from.length > 1)).map(t => ({ value : t, label : game.i18n.localize(CONFIG.DND5E.damageTypes[t]?.label ?? t) })) });
  }

  static #transmuted = new Map();

  /* What an option asks when it's chosen (kept with it on the card) : null stops the cast */
  static async chooseFor(id, actor, activity){
    if(id === "careful-spell") return { careful : Math.max(1, Number(actor.system.abilities?.cha?.mod) || 0) };
    if(id === "transmuted-spell"){
      const type = await this.chooseType(activity.item);
      if(!type) return null;
      this.#transmuted.set(activity.item.uuid, { type, at : Date.now() });
      return { damageType : type };
    }
    return {};
  }

  /* Once the cast went through and was paid : what lasts */
  static async afterOption(id, actor, activity){
    if(id === "quickened-spell") await markUsedThisTurn(actor, "quickened");
    if(id === "extended-spell") await extendDurations(actor, activity.item, { concentration : "advantage", reason : module.i18n("classes.sorcerer.extended") });
  }

  static registerMetamagic(){
    const enabled = () => this.enabled();
    castingChoice({
      id : "metamagic", enabled, icon : "fa-solid fa-wand-sparkles",
      applies : activity => activity?.item?.type === "spell",
      pool : actor => this.pointsOf(actor),
      options : (actor, activity) => this.optionsOf(actor).filter(o => !this.AFTER.includes(o.id)).map(o => ({
        id : o.id, item : o.item, cost : o.cost,
        label : module.format("classes.sorcerer.option", { name : o.item.name, cost : o.cost }),
        fits : a => this.fits(o.id, a),
        /* 2024 Quickened : not after a level 1+ spell this turn */
        allowed : (o.id !== "quickened-spell") ? null : (who => !usedThisTurn(who, "leveledSpell")
          || limits.allow(module.i18n("classes.sorcerer.quickenedAfter"), { who : who.name, what : activity.item.name })),
        choose : (who, a) => this.chooseFor(o.id, who, a),
        usage : (who, a) => this.usageOf(o.id, a),
        after : (who, a) => this.afterOption(o.id, who, a),
      })),
      title : activity => module.format("classes.sorcerer.metamagicTitle", { spell : activity.item.name }),
      prompt : (actor, left) => module.format("classes.sorcerer.metamagicPrompt", { left }),
      none : () => module.i18n("classes.sorcerer.none"),
      subtitle : record => {
        const type = record.damageType ? game.i18n.localize(CONFIG.DND5E.damageTypes[record.damageType]?.label ?? record.damageType) : null;
        return module.format(type ? "classes.sorcerer.faceType" : "classes.sorcerer.face", { cost : record.cost, type });
      },
    });
    /* 2024 Quickened : no level 1+ spell after it this turn; the level 1+ spells cast, for its own rule */
    cantUseWhile("afterQuickened", { enabled,
      uses : item => (item?.type === "spell") && (Number(item.system?.level) > 0),
      while : actor => usedThisTurn(actor, "quickened"),
      reason : () => module.i18n("classes.sorcerer.afterQuickened") });
    Hooks.on("dnd5e.postUseActivity", activity => {
      const actor = activity?.actor, item = activity?.item;
      if(this.enabled() && actor?.isOwner && (item?.type === "spell") && (Number(item.system?.level) > 0) && this.knows(actor, "quickened-spell")) markUsedThisTurn(actor, "leveledSpell");
    });
    /* Transmuted : its damage (cast now, or rolled again from its card within the minute) is the chosen type */
    onDamage((attack, damage) => this.transmute(attack, damage));

    /* Careful / Heightened : the save card's toggles */
    const chosenOn = (card, id) => { const record = castingChoiceOf(card, "metamagic"); return (record?.id === id) ? record : null; };
    saveRowToggle({ id : "careful", enabled, success : true, reason : card => chosenOn(card, "careful-spell")?.name,
      when : card => {
        const r = chosenOn(card, "careful-spell");
        return r && { limit : r.careful ?? 1, label : r.name, icon : "fa-shield-heart", hint : module.format("classes.sorcerer.carefulHint", { n : r.careful ?? 1 }) };
      } });
    saveRowToggle({ id : "heightened", enabled, mode : "disadvantage", reason : card => chosenOn(card, "heightened-spell")?.name,
      when : card => {
        const r = chosenOn(card, "heightened-spell");
        return r && { limit : 1, label : r.name, icon : "fa-arrow-trend-up", hint : module.i18n("classes.sorcerer.heightenedHint") };
      } });

    /* Empowered / Seeking : buttons on the card after the roll */
    const spellCard = card => card?.getAssociatedItem?.()?.type === "spell";
    const costOf = id => actor => ({ item : this.pointsOf(actor), amount : this.METAMAGIC[id] });
    rerollButton({ id : "empowered", roll : "damage", enabled, icon : "fa-burst", face : true,
      subtitle : () => module.format("classes.sorcerer.face", { cost : this.METAMAGIC["empowered-spell"] }),
      feature : actor => this.knows(actor, "empowered-spell")?.item ?? null, when : spellCard, cost : costOf("empowered-spell"),
      n : actor => Math.max(1, Number(actor.system.abilities?.cha?.mod) || 0),
      label : (actor, item, { n }) => module.format("classes.sorcerer.empowered", { name : item.name, n, cost : this.METAMAGIC["empowered-spell"] }) });
    rerollButton({ id : "seeking", roll : "attack", enabled, icon : "fa-crosshairs", face : true,
      subtitle : () => module.format("classes.sorcerer.face", { cost : this.METAMAGIC["seeking-spell"] }),
      feature : actor => this.knows(actor, "seeking-spell")?.item ?? null, when : spellCard, cost : costOf("seeking-spell"),
      label : (actor, item) => module.format("classes.sorcerer.seeking", { name : item.name, cost : this.METAMAGIC["seeking-spell"] }) });

    /* Gaining a Sorcerer level : one option replaced per level */
    restChoices.add({
      id : "metamagic", label : "restChoices.metamagic", rest : "level", classes : ["sorcerer"],
      count : (actor, { levels = 1 } = {}) => Math.max(1, Number(levels) || 1),
      applies : actor => this.enabled() && (this.optionsOf(actor).length > 0),
      summary : actor => module.format("classes.sorcerer.swapSummary", { names : this.optionsOf(actor).map(o => o.item.name).join(", "),
        swaps : restChoices.swapsText(actor, "metamagic") }),
      state : actor => this.optionsOf(actor).map(o => o.item.name),
      open : (actor, swap) => this.swapMetamagic(actor, swap),
    });
  }

  /* ---------- Transmuted Spell ---------- */

  static transmute(attack, damage){
    const chosen = attack.item ? this.#transmuted.get(attack.item.uuid) : null;
    if(!this.enabled() || !chosen || ((Date.now() - chosen.at) > 60000)) return;
    damage.setType(chosen.type, { only : this.TRANSMUTABLE });
  }

  /* ---------- Metamagic : replacing an option on gaining a level ---------- */

  /**
   * Replace a Metamagic option : which one goes, then which comes (every Item compendium : a copy of yours before
   * dnd5e's own, 2024 only, one per option); the new one takes the old one's place under the class.
   */
  static async swapMetamagic(actor, swap){
    const known = this.optionsOf(actor);
    if(!known.length || (swap && !(await swap.allow()))) return;
    const title = module.format("classes.sorcerer.swapTitle", { name : actor.name });
    const out = await chooseOne(known.map(o => ({ value : o.item.id, label : o.item.name, img : o.item.img })), {
      title, icon : "fa-solid fa-wand-sparkles", columns : 2, prompt : module.i18n("classes.sorcerer.swapOut") });
    const current = out ? actor.items.get(out) : null;
    if(!current) return;
    const owned = new Set(known.map(o => o.id));
    const source = await pickFromCompendium(e => { const id = this.metamagicId(e); return !!id && !owned.has(id); }, {
      key : e => this.metamagicId(e) ?? (e.system?.identifier || e.name),
      title, icon : "fa-solid fa-wand-sparkles", columns : 2, notice : module.i18n("classes.sorcerer.looking"),
      prompt : module.format("classes.sorcerer.swapIn", { name : current.name }),
      empty : module.format("classes.sorcerer.allOptions", { name : actor.name }) });
    if(!source) return;
    await replaceItem(current, source);
    await swap?.spend();
    log.debug("Metamagic swap", actor.name, current.name, "->", source.name);
  }

  /* ---------- Font of Magic ---------- */

  /**
   * The window : a slot into points (levels with a slot left, the points it gives) or points into a slot (levels 1-5
   * not full, what it costs). One conversion a use.
   */
  static async font(actor, item){
    const points = this.pointsOf(actor);
    if(!points) return ui.notifications.warn(module.format("classes.sorcerer.noPoints", { name : actor.name }));
    const left = Number(points.system.uses.value) || 0;
    const max = Number(points.system.uses.max) || 0;
    const slots = spellSlots(actor).filter(s => !s.pact);
    const sorcererLevel = Number(actor.classes?.sorcerer?.system?.levels) || 0;
    const toPoints = slots.filter(s => s.value > 0).map(s => ({ level : s.level, gain : Math.min(s.level, max - left) }));
    /* A new slot : any level 1-5 you have slots of (dnd5e casts only from those), from its Sorcerer level */
    const toSlot = slots.filter(s => s.level <= 5).map(s => ({ level : s.level, cost : this.SLOT_COST[s.level],
      locked : sorcererLevel < this.SLOT_MIN_LEVEL[s.level], made : Math.max(0, s.value - s.max) }));
    const made = toSlot.reduce((n, t) => n + t.made, 0);
    const button = (action, label, sub, disabled) => `<button type="button" data-convert="${action}"${disabled ? " disabled" : ""}><strong>${esc(label)}</strong><br><span class="hint">${esc(sub)}</span></button>`;
    const rowA = toPoints.map(t => button(`points|${t.level}`, module.format("classes.sorcerer.slotLevel", { level : t.level }),
      module.format("classes.sorcerer.gain", { n : t.gain }), t.gain <= 0)).join("") || `<p class="hint">${esc(module.i18n("classes.sorcerer.noSlots"))}</p>`;
    const rowB = toSlot.map(t => button(`slot|${t.level}`, module.format("classes.sorcerer.slotLevel", { level : t.level }),
      t.locked ? module.format("classes.sorcerer.fromLevel", { n : this.SLOT_MIN_LEVEL[t.level] }) : module.format("classes.sorcerer.cost", { n : t.cost }),
      t.locked || (t.cost > left))).join("") || `<p class="hint">${esc(module.i18n("classes.sorcerer.noSlotLevels"))}</p>`;
    let picked = null;
    await foundry.applications.api.DialogV2.wait({
      window : { title : item.name, icon : "fa-solid fa-wand-magic-sparkles" },
      content : `<p>${esc(module.format("classes.sorcerer.fontPoints", { left, max }))}</p>
        <h4>${esc(module.i18n("classes.sorcerer.toPoints"))}</h4><div class="${module.id}-font-row">${rowA}</div>
        <h4>${esc(module.i18n("classes.sorcerer.toSlot"))}</h4><div class="${module.id}-font-row">${rowB}</div>
        <p class="hint">${esc(module.format(made ? "classes.sorcerer.madeSlots" : "classes.sorcerer.madeHint", { n : made }))}</p>`,
      buttons : [{ action : "cancel", label : module.i18n("restChoices.done"), icon : "fa-solid fa-xmark" }],
      render : (event, dialog) => {
        dialog.element.querySelectorAll("button[data-convert]").forEach(b => b.addEventListener("click", () => {
          picked = b.dataset.convert;
          dialog.close();
        }));
      },
      rejectClose : false,
    }).catch(() => null);
    const choice = (typeof picked === "string" && picked.includes("|")) ? picked : null;
    if(!choice) return null;
    const [kind, lvl] = choice.split("|");
    const level = Number(lvl);
    const slot = actor.system.spells[`spell${level}`];
    if(kind === "points"){
      const gain = Math.min(level, max - (Number(points.system.uses.value) || 0));
      if(!(gain > 0) || !(Number(slot?.value) > 0)) return null;
      await addSpellSlot(actor, level, -1);
      await spendUses(points, -gain);
      ui.notifications.info(module.format("classes.sorcerer.gained", { name : actor.name, n : gain, level }));
    }
    else {
      const cost = this.SLOT_COST[level];
      if(!cost || ((Number(points.system.uses.value) || 0) < cost) || !(Number(slot?.max) > 0) || (sorcererLevel < this.SLOT_MIN_LEVEL[level])) return null;
      if(!(await spendUses(points, cost, { warn : false }))) return null;
      await addSpellSlot(actor, level, 1);
      ui.notifications.info(module.format("classes.sorcerer.created", { name : actor.name, n : cost, level }));
    }
    log.debug("Font of Magic", actor.name, choice);
    return true;
  }
}
