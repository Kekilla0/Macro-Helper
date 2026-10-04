import { module } from '../module.js';
import { settings } from '../settings.js';
import { limits } from './limits.js';
import { hands } from './hands.js';
import { usedThisTurn, markUsedThisTurn } from '../helpers/actors.js';
import { giveMode } from '../roll-item/reasons.js';

/**
 * Weapon properties, from the weapon's data and dnd5e's rules version (Modern 2024 / Legacy 2014) :
 *   Heavy        : disadvantage below STR 13 (melee) / DEX 13 (ranged) (2024), or for a Small / Tiny creature (2014)
 *   Hands        : two. A Two-Handed weapon takes both, other weapons and shields one; what's equipped must leave room
 *   Loading      : one shot per turn from that weapon, whatever the number of attacks (in combat)
 *   Light        : an off-hand attack needs an attack with a different Light weapon first this turn (in combat)
 *   In hand      : a character's weapon must be equipped (natural weapons and Unarmed Strike always are)
 * Heavy changes the roll; the rest are what you're allowed to do. The Weapon Property Rules setting warns (default),
 * blocks the roll, changes what can be changed (equips the weapon, takes a shield off for a Two-Handed weapon, holds a
 * Versatile weapon one-handed with a shield; Loading and Light can't be changed, they warn), or turns them all off.
 */
export class weapons{
  /* Shots / attacks noted this turn before their flag is saved (the next attack can come straight after) */
  static #noted = new Set();

  static #turnKey(actor, key){
    const c = game.combat;
    return `${actor?.uuid}|${key}|${c?.id}.${c?.round}.${c?.turn}`;
  }

  static #used(actor, key){
    return usedThisTurn(actor, key) || this.#noted.has(this.#turnKey(actor, key));
  }

  static async #mark(actor, key){
    if(!game.combat?.started) return;
    this.#noted.add(this.#turnKey(actor, key));
    await markUsedThisTurn(actor, key);
  }
  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("dnd5e.preRollAttackV2", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", (rolls, { subject } = {}) => this.onRollAttack(subject, rolls?.[0]));
    Hooks.on("updateItem", (item, changes, options, userId) => this.logEquip(item, foundry.utils.getProperty(changes ?? {}, "system.equipped"), userId));
    Hooks.on("createItem", (item, options, userId) => item.system?.equipped && this.logEquip(item, true, userId));
    Hooks.on("deleteItem", (item, options, userId) => item.system?.equipped && this.logEquip(item, false, userId, true));
  }

  /* Equipping / unequipping (or adding something already equipped) during a combat : a note only the GM sees,
     who / what / when on three lines, written by the GM's client */
  static async logEquip(item, equipped, userId, removed = false){
    if(!game.users.activeGM?.isSelf || (settings.value("weaponRules") === "off")) return;
    const actor = item.actor, combat = game.combat;
    if((equipped === undefined) || !actor || !combat?.started) return;
    if(!combat.combatants.some(c => (c.actor?.uuid === actor.uuid) || (c.actorId === actor.id))) return;
    const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
    const status = removed ? "rules.weapon.statusRemoved" : equipped ? "rules.weapon.statusEquipped" : "rules.weapon.statusUnequipped";
    const rows = [
      ["rules.weapon.logRound", `${String(combat.round ?? 0).padStart(2, "0")} (${esc(combat.combatant?.name ?? "—")})`],
      ["rules.weapon.logWho", esc(actor.name)],
      ["rules.weapon.logItem", esc(item.name)],
      ["rules.weapon.logStatus", module.i18n(status)],
    ];
    /* Armor and shields : how long it really takes, for the GM to rule on */
    const time = this.armorTime(item, equipped && !removed);
    if(time) rows.push(["rules.weapon.logTime", `<strong>${time}</strong>`]);
    const table = rows.map(([label, value]) => `<tr><th>${module.i18n(label)}</th><td>${value}</td></tr>`).join("");
    await ChatMessage.implementation.create({
      content : `<table class="${module.id}-equip-log">${table}</table>`,
      whisper : game.users.filter(u => u.isGM).map(u => u.id),
      speaker : { alias : module.title },
    });
  }

  /* Returns false (stopping the roll) when the Block setting finds a problem */
  static onPreRollAttack(config){
    const roll = config.rolls?.[0];
    if(!config.subject?.actor || !roll) return;
    roll.options ??= {};
    return this.applyWeaponRules(config, roll);
  }

  static isLegacy(){
    try { return game.settings.get("dnd5e", "rulesVersion") === "legacy"; }
    catch { return false; }
  }

  /**
   * Heavy's disadvantage, and the allowed-use checks (warn / block). Returns false to stop the roll when blocking.
   */
  static applyWeaponRules(config, roll){
    const mode = settings.value("weaponRules");
    const activity = config.subject;
    const item = activity?.item, actor = activity?.actor;
    if((mode === "off") || (item?.type !== "weapon") || !actor) return;
    const props = item.system.properties ?? new Set();
    const attackMode = config.attackMode ?? "";
    const actionType = String(activity.getActionType?.(attackMode) ?? "");
    const ranged = actionType.startsWith("r");

    /* Heavy */
    if(this.isHeavyFor(actor, item, ranged)) giveMode(roll, "disadvantage", module.i18n("reasons.heavy"));

    /* What's allowed. Change fixes what can be fixed (equipment, Versatile's grip); Loading and Light can't be, they warn */
    const change = mode === "change";
    const problems = [], changed = [];
    const thrown = attackMode.startsWith("thrown");

    /* In hand : a character's weapon must be equipped (natural weapons and Unarmed Strike always are; monsters'
       stat-block weapons often aren't marked equipped, so they don't count) */
    const natural = (item.system.type?.value === "natural") || ((item.identifier ?? item.system.identifier) === "unarmed-strike");
    /* Hands : in a hand, not just equipped. Change puts it in (the Hands rules : Two-Handed, Versatile); a two-handed grip
       needs it in both. They can't overfill, so there's nothing to count */
    if(hands.manages(actor) && !natural){
      const held = hands.handOf(actor, item);
      if(!held){
        if(change){
          const slot = hands.freeHand(actor, item) ?? "main";
          hands.put(actor, item, slot);
          changed.push(module.format("hands.putInHand", { item : item.name }));
        }
        else problems.push(module.format("hands.notInHand", { item : item.name }));
      }
      else if(!props.has("two") && (config.attackMode === "twoHanded") && (held !== "both")){
        if(change){
          config.attackMode = "oneHanded";
          roll.options.attackMode = "oneHanded";
          changed.push(module.format("rules.weapon.oneHanded", { item : item.name }));
        }
        else problems.push(module.format("hands.notBothHands", { item : item.name }));
      }
    }
    else if((actor.type === "character") && !item.system.equipped && !natural){
      if(change){ item.update({ "system.equipped" : true }); changed.push(module.format("rules.weapon.equipped", { item : item.name })); }
      else problems.push(module.format("rules.weapon.notEquipped", { item : item.name }));
    }

    /* Hands : a character has two. A Two-Handed weapon (a bow, a greatsword) takes both, any other weapon or a shield
       one. What else is equipped must leave room for this weapon; Change puts things away (two-handed weapons first,
       then other weapons, then shields) and holds a Versatile weapon one-handed rather than freeing a hand for it. */
    if((actor.type === "character") && !natural && !hands.manages(actor)){
      const others = actor.items.filter(i => (i.id !== item.id) && (this.handsOf(i) > 0));
      let held = others.reduce((sum, i) => sum + this.handsOf(i), 0);

      if(!props.has("two") && (config.attackMode === "twoHanded") && (held > 0)){
        if(change){
          config.attackMode = "oneHanded";
          roll.options.attackMode = "oneHanded";
          changed.push(module.format("rules.weapon.oneHanded", { item : item.name }));
        }
        else problems.push(module.format("rules.weapon.handsFull", { item : item.name, items : others.map(i => i.name).join(", ") }));
      }

      const need = ((props.has("two") && !thrown) || (config.attackMode === "twoHanded")) ? 2 : 1;
      if(held + need > 2){
        if(change){
          const order = [...others].sort((a, b) => (this.handsOf(b) - this.handsOf(a)) || ((a.type === "equipment") - (b.type === "equipment")));
          const away = [];
          for(const other of order){
            if(held + need <= 2) break;
            other.update({ "system.equipped" : false });
            held -= this.handsOf(other);
            away.push(other.name);
          }
          changed.push(module.format("rules.weapon.handsFreed", { item : item.name, items : away.join(", ") }));
        }
        else problems.push(module.format("rules.weapon.handsFull", { item : item.name, items : others.map(i => i.name).join(", ") }));
      }
    }

    if(props.has("lod") && this.#used(actor, `loading.${item.id}`)) problems.push(module.format("rules.weapon.loading", { item : item.name }));
    /* Hands : an off-hand attack is with what the left hand holds */
    if(attackMode.endsWith("offhand") && hands.manages(actor) && (hands.handOf(actor, item) !== "off")){
      problems.push(module.format("hands.notOffHand", { item : item.name }));
    }
    if(attackMode.endsWith("offhand") && !props.has("lgt")) problems.push(module.format("rules.weapon.offhandLight", { item : item.name }));
    if(attackMode.endsWith("offhand") && game.combat?.started){
      const otherLight = actor.items.some(i => (i.id !== item.id) && i.system.properties?.has?.("lgt") && this.#used(actor, `light.${i.id}`));
      if(!otherLight) problems.push(module.format("rules.weapon.light", { item : item.name }));
    }

    if(changed.length) ui.notifications.info(changed.join(" "));
    if(!problems.length) return;
    ui.notifications.warn(problems.join(" "));
    limits.log({ who : actor.name, what : item.name, rule : problems.join(" "), status : (mode === "block") ? "blocked" : "allowed" });
    if(mode === "block") return false;
  }

  /* Heavy : disadvantage below STR 13 (melee) / DEX 13 (ranged) (2024), or for a Small / Tiny creature (2014) */
  static isHeavyFor(actor, item, ranged){
    if((settings.value("weaponRules") === "off") || !item?.system?.properties?.has?.("hvy")) return false;
    return this.isLegacy()
      ? ["tiny", "sm"].includes(actor?.system?.traits?.size)
      : ((actor?.system?.abilities?.[ranged ? "dex" : "str"]?.value ?? 20) < 13);
  }

  /* 2024 donning / doffing : light 1 / 1 min, medium 5 / 1 min, heavy 10 / 5 min, a shield a Utilize action */
  static ARMOR_TIMES = { light : [1, 1], medium : [5, 1], heavy : [10, 5] };
  /* (the log's Time line reads "10 minutes to don" : the kind is already in the item's name) */

  static armorTime(item, donning){
    if(item?.type !== "equipment") return null;
    const kind = item.system?.type?.value;
    if(kind === "shield") return module.i18n(donning ? "rules.weapon.timeShieldOn" : "rules.weapon.timeShieldOff");
    const times = this.ARMOR_TIMES[kind];
    if(!times) return null;
    return module.format(donning ? "rules.weapon.timeDon" : "rules.weapon.timeDoff", { kind : module.i18n(`rules.weapon.armor.${kind}`), minutes : donning ? times[0] : times[1] });
  }

  /* Hands an equipped item takes : a shield 1, a Two-Handed weapon 2, any other weapon 1 (natural weapons and Unarmed Strike none) */
  static handsOf(item){
    if(!item?.system?.equipped) return 0;
    if((item.type === "equipment") && (item.system.type?.value === "shield")) return 1;
    if((item.type !== "weapon") || (item.system.type?.value === "natural")) return 0;
    if((item.identifier ?? item.system.identifier) === "unarmed-strike") return 0;
    return item.system.properties?.has?.("two") ? 2 : 1;
  }

  /* After a weapon attack : remember Loading's shot, and a Light weapon's main-hand attack, for the rest of the turn */
  static async onRollAttack(activity, roll){
    const item = activity?.item, actor = activity?.actor;
    if((item?.type !== "weapon") || !actor?.isOwner || (settings.value("weaponRules") === "off")) return;
    const props = item.system.properties ?? new Set();
    if(props.has("lod")) await this.#mark(actor, `loading.${item.id}`);
    if(props.has("lgt") && !String(roll?.options?.attackMode ?? "").endsWith("offhand")) await this.#mark(actor, `light.${item.id}`);
  }
}
