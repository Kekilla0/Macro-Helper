import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { esc } from '../helpers/utils.js';
import { limits } from './limits.js';
import { restChoices } from './rest-choices.js';
const log = logger.for(import.meta.url);

/**
 * Prepared Spells (Classes setting) : when a class may change its prepared spells (2024), as a Rest Choices row.
 *   Cleric, Druid, Wizard     : after a Long Rest, any of them.
 *   Paladin, Ranger           : after a Long Rest, one.
 *   Bard, Sorcerer, Warlock   : on gaining a level in the class, one.
 * The row's window lists the class's level 1+ spells (always-prepared ones shown, locked) with prepared / the class's
 * "max-prepared" scale and the changes left. Changes count against the list as it was at the rest : filling up to the
 * maximum is always free; a spell prepared in place of another uses a change. Past the maximum, or out of changes
 * (in the window or by ticking Prepared on the sheet) : Rule Limits decides.
 */
export class preparedSpells{
  static RULES = {
    cleric : { rest : "long", swaps : Infinity }, druid : { rest : "long", swaps : Infinity }, wizard : { rest : "long", swaps : Infinity },
    paladin : { rest : "long", swaps : 1 }, ranger : { rest : "long", swaps : 1 },
    bard : { rest : "level", swaps : 1 }, sorcerer : { rest : "level", swaps : 1 }, warlock : { rest : "level", swaps : 1 },
  };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    for(const [cls, rule] of Object.entries(this.RULES)){
      restChoices.add({
        id : `prepared-${cls}`, label : "restChoices.preparedSpells", rest : rule.rest, classes : (rule.rest === "level") ? [cls] : undefined,
        applies : actor => this.enabled() && !!actor?.classes?.[cls] && (this.spellsOf(actor, cls).length > 0),
        grant : actor => this.grant(actor, cls),
        summary : actor => this.summary(actor, cls),
        open : actor => this.choose(actor, cls),
      });
    }
    /* Ticking Prepared on the sheet : the same limits */
    Hooks.on("preUpdateItem", (item, changes, options) => this.onSheetChange(item, changes, options));
  }

  /* ---------- The class's spells ---------- */

  /* Which class a spell is prepared for ("class:cleric", or dnd5e's own link) */
  static classOf(spell){
    const source = String(spell?.system?.sourceItem ?? "");
    if(source.startsWith("class:")) return source.slice(6);
    return spell?.system?.classIdentifier || null;
  }

  /* The class's level 1+ spells that are prepared (not innate, not at will) */
  static spellsOf(actor, cls){
    return (actor?.items?.filter?.(i => (i.type === "spell") && (Number(i.system.level) > 0) && (this.classOf(i) === cls)
      && (i.system.method ? ["spell", "prepared"].includes(i.system.method) : true)) ?? [])
      .sort((a, b) => (a.system.level - b.system.level) || a.name.localeCompare(b.name));
  }

  static always(spell){
    return Number(spell.system.prepared) === 2;
  }

  /* The ones prepared by choice (always-prepared ones don't count) */
  static preparedIds(actor, cls){
    return this.spellsOf(actor, cls).filter(s => Number(s.system.prepared) === 1).map(s => s.id);
  }

  static maxOf(actor, cls){
    const scale = actor?.system?.scale?.[cls]?.["max-prepared"];
    const value = Number(scale?.value ?? scale);
    return Number.isFinite(value) ? value : null;
  }

  /* ---------- Changes since the rest ---------- */

  /* The list at the rest and the changes allowed (-1 : any). Never rested here : today's list, no changes */
  static stateOf(actor, cls){
    const state = actor.getFlag(module.id, `prepared.${cls}`);
    return state ?? { base : this.preparedIds(actor, cls), swaps : 0 };
  }

  static async grant(actor, cls){
    const swaps = this.RULES[cls].swaps;
    await actor.setFlag(module.id, `prepared.${cls}`, { base : this.preparedIds(actor, cls), swaps : Number.isFinite(swaps) ? swaps : -1 });
  }

  /**
   * What's wrong with a prepared list : past the maximum, or more spells newly prepared than allowed (filling up to the
   * maximum is free; the rest are changes).
   * @param {Actor} actor
   * @param {string} cls
   * @param {string[]} next   the spell ids prepared by choice
   * @returns {string[]}  problems (Rule Limits' words)
   */
  static problems(actor, cls, next){
    const max = this.maxOf(actor, cls);
    const { base, swaps } = this.stateOf(actor, cls);
    const out = [];
    const className = actor.classes?.[cls]?.name ?? cls;
    if((max !== null) && (next.length > max)) out.push(module.format("preparedSpells.overMax", { name : actor.name, cls : className, count : next.length, max }));
    const added = next.filter(id => !base.includes(id)).length;
    const free = (max === null) ? Infinity : Math.max(0, max - base.length);
    const allowed = (swaps < 0) ? Infinity : (swaps + free);
    if(added > allowed) out.push(module.format("preparedSpells.noChanges", { name : actor.name, cls : className }));
    return out;
  }

  /* Changes left now : "any", or a number */
  static changesLeft(actor, cls){
    const { base, swaps } = this.stateOf(actor, cls);
    if(swaps < 0) return "any";
    const max = this.maxOf(actor, cls);
    const next = this.preparedIds(actor, cls);
    const added = next.filter(id => !base.includes(id)).length;
    const free = (max === null) ? 0 : Math.max(0, max - base.length);
    return Math.max(0, swaps + free - added);
  }

  static summary(actor, cls){
    const left = this.changesLeft(actor, cls);
    return module.format("preparedSpells.summary", { cls : actor.classes?.[cls]?.name ?? cls, count : this.preparedIds(actor, cls).length,
      max : this.maxOf(actor, cls) ?? "—", changes : (left === "any") ? module.i18n("preparedSpells.any") : module.format("preparedSpells.left", { left }) });
  }

  /* ---------- The window ---------- */

  static async choose(actor, cls){
    const spells = this.spellsOf(actor, cls);
    const max = this.maxOf(actor, cls);
    const { base, swaps } = this.stateOf(actor, cls);
    /* Changes : spells prepared that weren't at the rest, past filling up to the maximum */
    const allowed = (swaps < 0) ? Infinity : (swaps + ((max === null) ? Infinity : Math.max(0, max - base.length)));
    const allowPast = limits.canGoPast() && Number.isFinite(allowed);
    /* One column per spell level, each scrolling past 10 spells; the list at the rest marked */
    const levels = [...new Set(spells.map(s => Number(s.system.level)))].sort((x, y) => x - y);
    const row = s => {
      const locked = this.always(s);
      const original = base.includes(s.id);
      const tip = locked ? module.i18n("preparedSpells.always") : original ? module.i18n("preparedSpells.original") : "";
      return `<label class="${module.id}-prepared-row${original ? " original" : ""}"${tip ? ` data-tooltip="${esc(tip)}"` : ""}>
          <input type="checkbox" name="${esc(s.id)}" ${(locked || Number(s.system.prepared) === 1) ? "checked" : ""} ${locked ? "disabled" : ""}>
          <img src="${esc(s.img)}" alt="" width="20" height="20"> <span class="name">${esc(s.name)}</span>${locked ? ` <i class="fa-solid fa-lock" inert></i>` : original ? ` <i class="fa-solid fa-bookmark ${module.id}-original-badge" inert></i>` : ""}
        </label>`;
    };
    const rows = levels.map(level => `<div class="${module.id}-prepared-column">
        <h4>${esc(module.format("preparedSpells.level", { level }))}</h4>
        <div class="${module.id}-prepared-list">${spells.filter(s => Number(s.system.level) === level).map(row).join("")}</div>
      </div>`).join("");
    /* The spells ticked (not the always-prepared ones, not the "past the rules" box) */
    const picked = form => [...form.querySelectorAll("input[type=checkbox]:not([disabled]):not([name=past])")].filter(i => i.checked).map(i => i.name);
    const next = await foundry.applications.api.DialogV2.wait({
      window : { title : module.format("preparedSpells.title", { cls : actor.classes?.[cls]?.name ?? cls, name : actor.name }), icon : "fa-solid fa-book" },
      position : { width : Math.min(960, 40 + (levels.length * 230)) },
      content : `<p class="${module.id}-prepared-count"></p>`
        + (allowPast ? `<label class="${module.id}-past"><input type="checkbox" name="past"> ${esc(module.i18n("preparedSpells.past"))}</label>` : "")
        + `<div class="${module.id}-prepared-columns">${rows}</div>`,
      buttons : [
        { action : "save", label : module.i18n("preparedSpells.save"), icon : "fa-solid fa-check", default : true,
          callback : (event, button) => Object.assign(picked(button.form), { past : !!button.form.querySelector('input[name="past"]')?.checked }) },
        { action : "cancel", label : module.i18n("restChoices.done"), icon : "fa-solid fa-xmark" },
      ],
      /* The limits, as boxes change : no more than the maximum, no more changes than allowed (an original back is free) */
      render : (event, dialog) => {
        const form = dialog.element;
        const line = form.querySelector(`.${module.id}-prepared-count`);
        const past = () => !!form.querySelector('input[name="past"]')?.checked;
        const show = (warning = "") => {
          const ids = picked(form);
          const added = ids.filter(id => !base.includes(id)).length;
          const left = Number.isFinite(allowed) ? Math.max(0, allowed - added) : module.i18n("preparedSpells.any");
          line.innerHTML = esc(module.format("preparedSpells.status", { count : ids.length, max : max ?? "—", left }))
            + (warning ? ` <strong class="warning">${esc(warning)}</strong>` : "");
        };
        form.querySelector('input[name="past"]')?.addEventListener("change", () => show());
        form.querySelectorAll("input[type=checkbox]:not([name=past])").forEach(input => input.addEventListener("change", () => {
          if(!input.checked) return show();
          const ids = picked(form);
          if((max !== null) && (ids.length > max)){ input.checked = false; return show(module.format("preparedSpells.full", { max })); }
          const added = ids.filter(id => !base.includes(id)).length;
          if(!past() && !base.includes(input.name) && (added > allowed)){ input.checked = false; return show(module.i18n("preparedSpells.noMore")); }
          show();
        }));
        show();
      },
      rejectClose : false,
    });
    if(!Array.isArray(next)) return false;
    /* Past the rules (allowed) : the GM is told; otherwise the window kept to them */
    const problems = this.problems(actor, cls, next);
    if(problems.length && next.past) await limits.tellGM({ who : actor.name, what : module.i18n("restChoices.preparedSpells"), rule : problems.join(" ") });
    else for(const problem of problems){
      if(!limits.allow(problem, { who : actor.name, what : module.i18n("restChoices.preparedSpells") })) return false;
    }
    const updates = spells.filter(s => !this.always(s)).map(s => ({ _id : s.id, "system.prepared" : next.includes(s.id) ? 1 : 0 }))
      .filter(u => u["system.prepared"] !== Number(actor.items.get(u._id)?.system.prepared));
    if(updates.length) await actor.updateEmbeddedDocuments("Item", updates, { [module.id] : { prepared : true } });
    log.debug("Prepared spells", actor.name, cls, next.length);
    return true;
  }

  /* ---------- The sheet ---------- */

  static onSheetChange(item, changes, options){
    if(!this.enabled() || options?.[module.id]?.prepared || (item?.type !== "spell") || !foundry.utils.hasProperty(changes ?? {}, "system.prepared")) return;
    const actor = item.parent;
    const cls = this.classOf(item);
    if(!actor || !this.RULES[cls] || this.always(item)) return;
    const prepare = Number(foundry.utils.getProperty(changes, "system.prepared")) === 1;
    if(!prepare) return;
    const next = [...new Set([...this.preparedIds(actor, cls), item.id])];
    for(const problem of this.problems(actor, cls, next)){
      if(!limits.allow(problem, { who : actor.name, what : item.name })) return false;
    }
  }
}
