import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { limits } from './limits.js';
import { heldLight } from './held-light.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * Hands (Equipment page) : two slots on the character sheet, at the bottom corners of the portrait : the main hand and
 * the off hand. Main Hand (each user's setting) : right (the default : the main hand on the viewer's left, as the
 * character faces you) or left. Drag an item from the sheet into a hand, or use the item's right-click menu (Equip to
 * Main Hand / Off Hand, for one-handed items) :
 *   Two-Handed     : it takes both hands, whatever was in them goes.
 *   One-handed     : that hand; the other keeps what it holds (a Two-Handed item held there is let go).
 *   Versatile      : two-handed when the other hand is empty, one-handed once something else is held (with Dueling :
 *                    always one-handed, its +2 needs it).
 *   Shields, torches, anything you carry : one hand. Armor is worn, not held.
 * dnd5e's "equipped" follows : what's in a hand is equipped, what leaves it isn't (weapons and shields). Right-click
 * a hand to empty it. Equipping or unequipping a weapon or shield on the sheet puts it in (a free hand) or takes it
 * out; with no hand free, Rule Limits decides. An off-hand attack (the Light extra attack) is with the item in the
 * left hand, and a Versatile weapon rolls two-handed only when it's in both.
 *   Light          : a torch, lantern, lamp or candle in a hand lights the token, with its burn time (held-light.js).
 */
export class hands{
  static SLOTS = ["main", "off"];


  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("handsEnabled");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderActorSheetV2", (app, html) => this.renderSlots(app, html));
    Hooks.on("updateItem", (item, changes, options, userId) => this.onEquip(item, changes, options, userId));
    /* Gear arrives equipped (Plutonium, dnd5e's starting equipment) : not in a hand, so not equipped */
    Hooks.on("preCreateItem", (item, data, options) => this.onPreCreate(item, options));
    Hooks.on("deleteItem", (item, options, userId) => this.onDelete(item, userId));
    Hooks.on("dnd5e.getItemContextOptions", (item, options) => this.contextOptions(item, options));
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
  }

  /* ---------- Something held used as a weapon (a torch) ---------- */

  /**
   * An attack with a held item that isn't a weapon (an improvised weapon : a burning torch) : only from the main hand
   * (Rule Limits), and it counts as a weapon in hand for the rest of the turn (Dueling's "no other weapons").
   * @returns {false|void}  false : stopped (Block)
   */
  static onPreRollAttack(config){
    const item = config?.subject?.item, actor = config?.subject?.actor;
    if(!this.manages(actor) || !item || (item.type === "weapon") || !this.canHold(item)) return;
    const held = this.handOf(actor, item);
    if(!["main", "both"].includes(held)){
      const rule = module.format(held ? "hands.improvisedMain" : "hands.notInHand", { item : item.name });
      if(!limits.allow(rule, { who : actor.name, what : module.format("hands.attackedWith", { item : item.name }) })) return false;
    }
    markUsedThisTurn(actor, `wielded.${item.id}`);
  }

  /* Wielded as a weapon this turn (attacked with) */
  static wieldedThisTurn(actor, item){
    return !!item && usedThisTurn(actor, `wielded.${item.id}`);
  }

  /* Each user's own : which hand is the main one */
  static mainIsLeft(){
    return settings.value("handsMain") === "left";
  }

  /* "Right hand (main)", "Left hand (off)"... for a slot, from the Main Hand setting */
  static slotLabel(slot){
    const left = this.mainIsLeft() ? (slot === "main") : (slot === "off");
    return module.format(`hands.${slot}`, { side : module.i18n(left ? "hands.left" : "hands.right") });
  }

  /* ---------- The item's right-click menu ---------- */

  /* A one-handed item : Equip to Main Hand / Off Hand instead of dnd5e's Equip (Unequip stays when it's held) */
  static contextOptions(item, options){
    const actor = item?.parent;
    if(!this.manages(actor) || !item.isOwner || !this.canHold(item) || this.isTwoHanded(item)) return;
    const at = options.findIndex(o => /^DND5E\.ContextMenuAction(Un)?[Ee]quip$/.test(String(o.label ?? "")));
    const held = this.handOf(actor, item);
    const ours = this.SLOTS.filter(slot => (held !== slot) && (held !== "both" || slot === "off")).map(slot => ({
      label : module.format("hands.equipTo", { hand : this.slotLabel(slot) }),
      icon : `fa-solid fa-hand fa-fw${((slot === "main") !== this.mainIsLeft()) ? " fa-flip-horizontal" : ""}`,
      group : "state",
      onClick : () => this.put(actor, item, slot),
    }));
    if(held) ours.push({ label : "DND5E.ContextMenuActionUnequip", icon : "fa-solid fa-shield-alt fa-fw", group : "state",
      onClick : () => this.empty(actor, (held === "off") ? "off" : "main") });
    if(at >= 0) options.splice(at, 1, ...ours);
    else options.push(...ours);
  }

  static idOf(item){
    return item?.identifier ?? item?.system?.identifier ?? "";
  }

  /* ---------- What can be held, and how ---------- */

  /* Armor is worn; natural weapons and Unarmed Strike aren't held; everything else physical can be */
  static canHold(item){
    if(!item || !["weapon", "equipment", "tool", "consumable", "loot", "container"].includes(item.type)) return false;
    /* Worn, not held */
    if((item.type === "equipment") && ["light", "medium", "heavy", "natural", "clothing", "ring", "vehicle"].includes(item.system.type?.value)) return false;
    if((item.type === "weapon") && ((item.system.type?.value === "natural") || (this.idOf(item) === "unarmed-strike"))) return false;
    return true;
  }

  static isTwoHanded(item){
    return !!item?.system?.properties?.has?.("two");
  }

  static isVersatile(item){
    return !!item?.system?.properties?.has?.("ver");
  }

  static hasDueling(actor){
    return !!actor?.items?.some?.(i => ["dueling", "fighting-style-dueling"].includes(this.idOf(i)));
  }

  /* An item that's "in hand" in dnd5e's sense : weapons and shields (equipped follows the hands) */
  static isHeldGear(item){
    return (item?.type === "weapon") || ((item?.type === "equipment") && (item.system.type?.value === "shield"));
  }

  /* ---------- The hands ---------- */

  /**
   * What each hand holds (only items still on the actor).
   * @param {Actor} actor
   * @returns {{ main : string|null, off : string|null }}  item ids; the same id in both : held in two hands
   */
  static of(actor){
    const stored = actor?.getFlag?.(module.id, "hands") ?? {};
    const has = id => (id && actor.items?.get?.(id)) ? id : null;
    return { main : has(stored.main), off : has(stored.off) };
  }

  /* Held in both hands (a Two-Handed weapon, or Versatile used two-handed) */
  static inBothHands(actor, item){
    const h = this.of(actor);
    return !!item && (h.main === item.id) && (h.off === item.id);
  }

  /* Which hand holds it : "main", "off", "both" or null */
  static handOf(actor, item){
    const h = this.of(actor);
    if(!item) return null;
    if((h.main === item.id) && (h.off === item.id)) return "both";
    return (h.main === item.id) ? "main" : (h.off === item.id) ? "off" : null;
  }

  /* The items in the hands (one entry each, a two-handed one once) */
  static heldItems(actor){
    const h = this.of(actor);
    return [...new Set([h.main, h.off].filter(Boolean))].map(id => actor.items.get(id)).filter(Boolean);
  }

  /* A free hand for an item : main, then off; null when both are taken (a Two-Handed item needs both free) */
  static freeHand(actor, item){
    const h = this.of(actor);
    if(this.isTwoHanded(item)) return (!h.main && !h.off) ? "main" : null;
    return !h.main ? "main" : !h.off ? "off" : null;
  }

  /* Is this actor's equipment run by the hands ? (a character, with the setting on) */
  static manages(actor){
    return this.enabled() && (actor?.type === "character");
  }

  /**
   * The hands after putting an item in one (the rules above), without saving.
   * @param {Actor} actor
   * @param {{ main, off }} current
   * @param {Item} item
   * @param {"main"|"off"} slot
   * @returns {{ main, off }}
   */
  static placed(actor, current, item, slot){
    const other = (slot === "main") ? "off" : "main";
    const next = { ...current };
    if(this.isTwoHanded(item)) return { main : item.id, off : item.id };
    /* What filled both hands : a Versatile one keeps a hand, a Two-Handed one is let go */
    if(next.main && (next.main === next.off)){
      const held = actor.items.get(next.main);
      next.main = next.off = null;
      if(held && this.isVersatile(held) && (held.id !== item.id)) next[other] = held.id;
    }
    /* Moving it from the other hand */
    if(next[other] === item.id) next[other] = null;
    next[slot] = item.id;
    return this.normalised(actor, next);
  }

  /* A Versatile item alone in one hand takes the other (two-handed), unless Dueling wants it one-handed */
  static normalised(actor, h){
    const next = { ...h };
    for(const [slot, other] of [["main", "off"], ["off", "main"]]){
      const item = next[slot] && actor.items.get(next[slot]);
      if(item && !next[other] && this.isVersatile(item) && !this.hasDueling(actor)) next[other] = item.id;
    }
    return next;
  }

  /**
   * Save the hands, and dnd5e's equipped to match : held gear equipped, gear let go unequipped.
   * @param {Actor} actor
   * @param {{ main, off }} next
   */
  static async save(actor, next){
    const before = this.of(actor);
    const held = new Set([next.main, next.off].filter(Boolean));
    const was = new Set([before.main, before.off].filter(Boolean));
    const updates = [];
    for(const id of held){
      const item = actor.items.get(id);
      if(item && this.isHeldGear(item) && !item.system.equipped) updates.push({ _id : id, "system.equipped" : true });
    }
    for(const id of was){
      const item = actor.items.get(id);
      if(item && !held.has(id) && this.isHeldGear(item) && item.system.equipped) updates.push({ _id : id, "system.equipped" : false });
    }
    await actor.setFlag(module.id, "hands", { main : next.main ?? null, off : next.off ?? null });
    if(updates.length) await actor.updateEmbeddedDocuments("Item", updates, { [module.id] : { hands : true } });
    await this.syncLights(actor, held, was);
    log.debug("Hands", actor.name, next);
  }

  /* What's held changed : its light (held-light.js) */
  static async syncLights(actor, held, was){
    await heldLight.sync(actor, held, was);
  }

  static async put(actor, item, slot){
    if(!this.canHold(item)) return ui.notifications.warn(module.format("hands.cantHold", { item : item?.name ?? "" }));
    await this.save(actor, this.placed(actor, this.of(actor), item, slot));
  }

  /* Empty a hand (both, if what it holds is in both); a Versatile item left alone goes two-handed */
  static async empty(actor, slot){
    const h = this.of(actor);
    const id = h[slot];
    if(!id) return;
    const next = { ...h };
    if(next.main === next.off) next.main = next.off = null;
    else next[slot] = null;
    await this.save(actor, this.normalised(actor, next));
  }

  /* ---------- The sheet ---------- */

  static renderSlots(app, html){
    const actor = app.document ?? app.actor;
    if(!this.manages(actor)) return;
    if(actor.isOwner) this.tidySoon(actor);
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    const portrait = root?.querySelector(".sidebar .portrait") ?? app.element?.querySelector?.(".sidebar .portrait");
    if(!portrait || portrait.querySelector(`.${module.id}-hands`)) return;
    const h = this.of(actor);
    const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
    const editable = app.isEditable ?? actor.isOwner;
    const slot = name => {
      const item = h[name] ? actor.items.get(h[name]) : null;
      const both = item && (h.main === h.off);
      const label = this.slotLabel(name);
      const tip = item ? `${label} : ${item.name}${both ? ` (${module.i18n("hands.twoHands")})` : ""}` : `${label} : ${module.i18n("hands.empty")}`;
      return `<div class="${module.id}-hand ${name}${item ? " full" : ""}${both ? " both" : ""}" data-hand="${name}" data-tooltip="${esc(tip)}" aria-label="${esc(tip)}">
          ${item ? `<img src="${esc(item.img)}" alt="">` : `<i class="fa-solid fa-hand${(((name === "main") !== this.mainIsLeft())) ? " flip" : ""}" inert></i>`}
          ${both ? `<i class="fa-solid fa-link link" inert></i>` : ""}
        </div>`;
    };
    const box = document.createElement("div");
    box.className = `${module.id}-hands`;
    /* As the character faces you : its right hand on your left */
    box.innerHTML = this.mainIsLeft() ? (slot("off") + slot("main")) : (slot("main") + slot("off"));
    portrait.append(box);
    if(!editable) return;
    for(const el of box.querySelectorAll("[data-hand]")){
      el.addEventListener("dragover", event => { event.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", async event => {
        event.preventDefault();
        event.stopPropagation();
        el.classList.remove("over");
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        const item = data?.uuid ? await fromUuid(data.uuid) : null;
        /* Only the character's own items (from its sheet) */
        if(!item || (item.parent !== actor)) return ui.notifications.warn(module.i18n("hands.ownItems"));
        await this.put(actor, item, el.dataset.hand);
      });
      el.addEventListener("contextmenu", async event => {
        event.preventDefault();
        event.stopPropagation();
        await this.empty(actor, el.dataset.hand);
      });
      /* A click opens what it holds */
      el.addEventListener("click", event => {
        const id = this.of(actor)[el.dataset.hand];
        if(!id) return;
        event.preventDefault();
        event.stopPropagation();
        actor.items.get(id)?.sheet?.render(true);
      });
    }
  }

  /* ---------- The sheet's own Equipped toggle ---------- */

  /* Equipped on the sheet : into a free hand (both for Two-Handed); no room : Rule Limits. Unequipped : out of hand */
  static async onEquip(item, changes, options = {}, userId){
    if((userId !== game.user.id) || options[module.id]?.hands) return;
    const actor = item?.parent;
    if(!this.manages(actor) || !this.isHeldGear(item)) return;
    const equipped = foundry.utils.getProperty(changes ?? {}, "system.equipped");
    if(equipped === undefined) return;
    const h = this.of(actor);
    if(!equipped){
      if(this.handOf(actor, item)) await this.empty(actor, this.handOf(actor, item) === "off" ? "off" : "main");
      return;
    }
    if(this.handOf(actor, item)) return;
    const free = this.isTwoHanded(item) ? ((!h.main && !h.off) ? "main" : null)
      : !h.main ? "main" : !h.off ? "off" : null;
    if(free) return this.save(actor, this.placed(actor, h, item, free));
    /* A Versatile item held two-handed makes room for one more */
    const versatileBoth = h.main && (h.main === h.off) && this.isVersatile(actor.items.get(h.main));
    if(versatileBoth && !this.isTwoHanded(item)) return this.save(actor, this.placed(actor, h, item, "off"));
    if(limits.allow(module.format("hands.full", { name : actor.name, item : item.name }), { who : actor.name, what : module.format("hands.equipped", { item : item.name }) })){
      return this.save(actor, this.placed(actor, h, item, "main"));
    }
    await item.update({ "system.equipped" : false }, { [module.id] : { hands : true } });
  }

  /* Equipped held gear arriving on a character : unequipped (the hands decide what's held) */
  static onPreCreate(item, options = {}){
    const actor = item?.parent;
    if(options[module.id]?.hands || !this.manages(actor) || !this.isHeldGear(item) || !this.canHold(item) || !item.system?.equipped) return;
    item.updateSource({ "system.equipped" : false });
  }

  static #tidying = new Map();

  /* Weapons and shields equipped but not in a hand (auto-equipped, or from before Hands) */
  static strays(actor){
    const held = new Set(this.heldItems(actor).map(i => i.id));
    return actor.items.filter(i => this.isHeldGear(i) && this.canHold(i) && i.system.equipped && !held.has(i.id));
  }

  /* The sheet shows the hands : strays unequipped, a moment later (an Equip being put in a hand finishes first) */
  static tidySoon(actor){
    if(!this.strays(actor).length) return;
    clearTimeout(this.#tidying.get(actor.uuid));
    this.#tidying.set(actor.uuid, setTimeout(() => {
      this.#tidying.delete(actor.uuid);
      this.tidy(actor).catch(error => log.error(error));
    }, 600));
  }

  static async tidy(actor){
    const updates = this.strays(actor).map(i => ({ _id : i.id, "system.equipped" : false }));
    if(updates.length) await actor.updateEmbeddedDocuments("Item", updates, { [module.id] : { hands : true } });
    log.debug("Hands tidied", actor.name, updates.length);
  }

  static async onDelete(item, userId){
    if(userId !== game.user.id) return;
    const actor = item?.parent;
    if(!this.manages(actor)) return;
    const stored = actor.getFlag(module.id, "hands") ?? {};
    /* A held torch used up : its light goes too */
    await heldLight.putOut(actor, item.id);
    if((stored.main === item.id) || (stored.off === item.id)) await this.save(actor, this.normalised(actor, this.of(actor)));
  }
}
