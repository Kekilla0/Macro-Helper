import { module } from '../module.js';

/**
 * A creature's picture on a chat card (its row, a push button...) : clicking it pans your view to its token, and
 * selects it for the GM or its owner (Shift adds it to the selection). Pictures say which token with data-token="<uuid>".
 * Players get nothing for a token they can't see (GM-hidden, Invisible, out of sight), so a card never gives one away.
 */
export class chatPictures {
  static register(){
    document.addEventListener("click", event => {
      const img = event.target?.closest?.("img[data-token]");
      if(!img?.dataset.token || !img.closest("[data-message-id]")) return;
      event.preventDefault();
      event.stopPropagation();
      this.show(img.dataset.token, { add : event.shiftKey });
    });
  }

  /* Pan to a token (by uuid, or the token), and select it when you may */
  static show(thing, { add = false } = {}){
    const doc = (typeof thing === "string") ? fromUuidSync(thing, { strict : false }) : (thing?.document ?? thing);
    if(doc?.documentName !== "Token") return false;
    if(doc.parent !== canvas.scene){
      if(game.user.isGM) ui.notifications.info(module.format("chatPictures.otherScene", { name : doc.name, scene : doc.parent?.name ?? "" }));
      return false;
    }
    const token = doc.object;
    if(!token || (!game.user.isGM && !token.visible)) return false;
    canvas.animatePan({ x : token.center.x, y : token.center.y, duration : 250 });
    if(game.user.isGM || doc.isOwner) token.control({ releaseOthers : !add });
    return true;
  }
}
