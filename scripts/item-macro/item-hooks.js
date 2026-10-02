import { module } from '../module.js';
import { logger } from '../log.js';
import { itemMacro } from './item-macro.js';
const log = logger.for(import.meta.url);

/**
 * Item hooks : an item's macro can also run when a hook fires, for passive features that react on their own
 * (Relentless Endurance on "dnd5e.preApplyDamage"). It lives on the item, so it comes and goes with the creature :
 *   only items of creatures with a token on the scene you're viewing are listened for,
 *   and by default only when the hook is about that creature (its first argument is the creature, its token or item).
 *
 * Stored with the item macro : { hooks : [...], customHooks : [...], runAs : "owner" | "gm", self : true, author }
 *   owner : on the client where the hook fires, if that user owns the creature (hooks like preApplyDamage only fire there)
 *   gm    : once, on the active GM (hooks that fire for everyone : actor changed, combat turn)
 * Only macros saved by a GM run from hooks, like Hook Macros. A player who edits the flags directly loses the GM mark.
 * The macro gets `hook` and `args`, with `item`, `actor` and `token` as usual. Like Hook Macros it runs inside the hook,
 * so until its first `await` it can change what the hook passed.
 */
export class itemHooks{
  /* hook name -> Hooks.on id */
  static #registered = new Map();

  static register(){
    Hooks.once("ready", ()=> {
      this.sync();
      const later = foundry.utils.debounce(()=> this.sync(), 100);
      for(const hook of ["canvasReady", "createToken", "deleteToken", "updateToken", "createItem", "updateItem", "deleteItem", "updateActor"]){
        Hooks.on(hook, later);
      }
      Hooks.on("updateItem", (item, changes, options, userId)=> this.guard(item, changes, userId));
    });
  }

  static hooksOf(data){
    if(!data?.command?.trim() || (data.mode === "default")) return [];
    const hooks = [...(data.hooks ?? []), ...(data.customHooks ?? [])].map(h => String(h).trim()).filter(Boolean);
    return [...new Set(hooks)];
  }

  /* Creatures with a token on the scene being viewed, each once (linked actors can have several tokens) */
  static actorsOnScene(){
    const actors = new Map();
    for(const token of canvas.tokens?.placeables ?? []){
      if(token.actor) actors.set(token.actor.uuid, token.actor);
    }
    return [...actors.values()];
  }

  /* Items on the scene whose macro listens to this hook (every hook when none given) */
  static itemsFor(hook){
    return this.actorsOnScene().flatMap(actor => actor.items.filter(item => {
      const hooks = this.hooksOf(itemMacro.data(item));
      return hooks.length && (!hook || hooks.includes(hook));
    }));
  }

  /* Keep one listener per hook that an item on the scene uses */
  static sync(){
    const wanted = new Set(this.itemsFor().flatMap(item => this.hooksOf(itemMacro.data(item))));

    for(const [hook, id] of this.#registered){
      if(wanted.has(hook)) continue;
      Hooks.off(hook, id);
      this.#registered.delete(hook);
    }
    for(const hook of wanted){
      if(this.#registered.has(hook)) continue;
      this.#registered.set(hook, Hooks.on(hook, (...args)=> this.run(hook, args)));
    }
    log.debug("Item hooks in use", [...wanted]);
  }

  /* The creature a hook is about : its first argument, as an actor (token, item, activity, effect, combat's current turn...) */
  static subjectOf(args){
    const first = args[0];
    if(!first) return null;
    if(first.documentName === "Actor") return first;
    if(first.documentName === "Combat") return first.combatant?.actor ?? null;
    if(first.documentName === "ChatMessage") return first.getSpeakerActor?.() ?? null;
    /* dnd5e roll configs (preRollAttackV2, preRollSavingThrowV2...) : their subject is the actor or the activity */
    if(first.subject) return (first.subject.documentName === "Actor") ? first.subject : (first.subject.actor ?? null);
    return first.actor ?? ((first.parent?.documentName === "Actor") ? first.parent : null);
  }

  static shouldRun(item, data){
    if(!game.users.get(data.author)?.isGM) return false;
    if((data.runAs ?? "owner") === "gm") return !!game.users.activeGM?.isSelf;
    return !!item.actor?.isOwner;
  }

  static run(hook, args){
    const subject = this.subjectOf(args);
    for(const item of this.itemsFor(hook)){
      const data = itemMacro.data(item);
      if((data.self ?? true) && (subject?.uuid !== item.actor?.uuid)) continue;
      if(!this.shouldRun(item, data)) continue;
      log.debug("Running item hook", item.name, "for", hook);
      /* Not awaited : the macro runs up to its first await right here, inside the hook */
      itemMacro.execute(item, itemMacro.scope(item, { hook, args }));
    }
  }

  /**
   * A player changing an item macro's hooks or GM mark directly (not through the editor as a GM) : the GM's client
   * drops the mark, so the macro stops running from hooks until a GM saves it again.
   */
  static guard(item, changes, userId){
    if(!game.users.activeGM?.isSelf || game.users.get(userId)?.isGM) return;
    const changed = foundry.utils.getProperty(changes, `flags.${module.id}.macro`);
    if(!changed || !this.hooksOf(itemMacro.data(item)).length) return;
    if(!game.users.get(itemMacro.data(item)?.author)?.isGM) return;
    log.info(`${item.name} : item macro changed by a player, its hooks are off until a GM saves it.`);
    item.update({ [`flags.${module.id}.macro.author`] : userId });
  }
}
