// Original LineBridge line icons on a 24px grid. styles.css draws them with
// round 1.75px strokes, so they stay crisp, follow the theme and can animate.
const paths={
  play:'<circle cx="12" cy="12" r="8.75"/><path d="M10.25 8.9v6.2l5-3.1z"/>',
  pulse:'<path d="M3 12h3.6l2.4-6.2 4.8 12.4 2.4-6.2H21"/>',
  search:'<circle cx="11" cy="11" r="6.75"/><path d="m20 20-4.2-4.2"/>',
  chats:'<path d="M7.5 12.5H6L3.25 15V6a2.5 2.5 0 0 1 2.5-2.5h6.5A2.5 2.5 0 0 1 14.75 6v1"/><path d="M11.75 9h6.5a2.5 2.5 0 0 1 2.5 2.5V20L18 17.5h-6.25a2.5 2.5 0 0 1-2.5-2.5v-3.5A2.5 2.5 0 0 1 11.75 9z"/>',
  key:'<circle cx="8" cy="15.5" r="4.25"/><path d="m11 12.5 8.5-8.5"/><path d="m16.5 7 2.5 2.5"/><path d="m14 9.5 2 2"/>',
  cloud:'<path d="M7 19a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5-.84A4.9 4.9 0 0 1 17 19z"/>',
  history:'<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/>',
  refresh:'<path d="M20 11.5A8 8 0 0 0 5.7 6.6L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 12.5a8 8 0 0 0 14.3 4.9l1.7-1.9"/><path d="M20 20v-4.5h-4.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  x:'<path d="m6.5 6.5 11 11m0-11-11 11"/>',
  check:'<path pathLength="1" d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronRight:'<path d="m9.5 6 6 6-6 6"/>',
  chevronLeft:'<path d="m14.5 6-6 6 6 6"/>',
  arrowRight:'<path d="M4.5 12h15m-6-6 6 6-6 6"/>',
  send:'<path d="m20.5 3.5-10 10"/><path d="m20.5 3.5-6.4 17.2-3.6-7.2-7.2-3.6z"/>',
  external:'<path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  shield:'<path d="M12 3.25 5 6v5.25c0 4.25 2.9 7.9 7 9.5 4.1-1.6 7-5.25 7-9.5V6z"/><path d="m9.25 12.25 2 2 3.75-3.75"/>',
  lock:'<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3"/>',
  sparkle:'<path class="solid" d="M12 3.5Q12.9 11.1 20.5 12 12.9 12.9 12 20.5 11.1 12.9 3.5 12 11.1 11.1 12 3.5z"/>',
  copy:'<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  trash:'<path d="M4.5 7h15"/><path d="M9.5 7V5.25A1.25 1.25 0 0 1 10.75 4h2.5a1.25 1.25 0 0 1 1.25 1.25V7"/><path d="m6.5 7 .8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10 11v5.5m4-5.5v5.5"/>',
  power:'<path d="M12 3.5v8"/><path d="M7 6.5a7.5 7.5 0 1 0 10 0"/>',
  qr:'<rect x="4" y="4" width="6" height="6" rx="1.25"/><rect x="14" y="4" width="6" height="6" rx="1.25"/><rect x="4" y="14" width="6" height="6" rx="1.25"/><path d="M14 14h2.5v2.5H14zm3.5 3.5H20V20h-2.5zM20 14h.01M14 20h.01"/>',
  info:'<circle cx="12" cy="12" r="8.75"/><path d="M12 11v5"/><path d="M12 7.75h.01"/>',
  alert:'<path d="M10.3 4.3 2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  globe:'<circle cx="12" cy="12" r="8.75"/><path d="M3.25 12h17.5"/><path d="M12 3.25c2.3 2.4 3.4 5.3 3.4 8.75s-1.1 6.35-3.4 8.75c-2.3-2.4-3.4-5.3-3.4-8.75S9.7 5.65 12 3.25z"/>',
  laptop:'<rect x="4.5" y="5" width="15" height="10.5" rx="1.75"/><path d="M2.5 19h19"/>',
  bolt:'<path d="M13 3 5.5 13.5h6l-1 7.5L18 10.5h-6z"/>',
  terminal:'<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 2.5 2.5L7 14.5m5.5 0H17"/>',
  flask:'<path d="M9 3.5h6"/><path d="M10 3.5V9l-5.2 8.8a1.8 1.8 0 0 0 1.6 2.7h11.2a1.8 1.8 0 0 0 1.6-2.7L14 9V3.5"/><path d="M7.25 15h9.5"/>',
  chat:'<path d="M7.5 18.5 4 21V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8.5a3 3 0 0 1-3 3z"/>',
  users:'<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6m2.5 2.5a6.5 6.5 0 0 1 3.5 5.2"/>',
  inbox:'<path d="m3.5 13.5 2.5-7.3A2 2 0 0 1 7.9 5h8.2a2 2 0 0 1 1.9 1.2l2.5 7.3V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/><path d="M3.5 13.5H8l1.2 2.2h5.6l1.2-2.2h4.5"/>'
};
export function icon(name,extra=''){
  const body=paths[name];
  return body?`<svg class="icon${extra?` ${extra}`:''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`:'';
}
// Static markup names its icon with data-icon; it becomes the first child.
export function hydrateIcons(root=document){
  root.querySelectorAll('[data-icon]').forEach(el=>{el.insertAdjacentHTML('afterbegin',icon(el.dataset.icon));el.removeAttribute('data-icon');});
}
