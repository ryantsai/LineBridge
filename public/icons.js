// Phosphor Core 2.1.1, MIT; vendored SVGs are referenced by styles.css.
const names=new Set(['play-circle','chats-circle','users','key','arrows-left-right','clock-counter-clockwise','arrows-clockwise','plus','x','shield-check','chat-circle-dots','caret-right','caret-left','check','link','eye','paper-plane-tilt','magnifying-glass','plug','gear-six','arrow-square-out']);
export function icon(name){return names.has(name)?`<span class="icon icon-${name}" aria-hidden="true"></span>`:'';}
