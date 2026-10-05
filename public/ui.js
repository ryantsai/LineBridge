import {icon} from './icons.js';

export const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

const originals=new WeakMap(),timers=new WeakMap();
// Briefly swaps a button's label for a drawn check mark, then restores it.
export function confirmButton(button,text='已複製'){
  if(!button)return;
  if(!originals.has(button))originals.set(button,button.innerHTML);
  clearTimeout(timers.get(button));
  button.innerHTML=icon('check','draw')+(button.classList.contains('icon-btn')?'':`<span>${text}</span>`);
  button.classList.add('done');
  timers.set(button,setTimeout(()=>{button.innerHTML=originals.get(button);originals.delete(button);button.classList.remove('done');},1600));
}

export async function copyText(text,button){
  try{await navigator.clipboard.writeText(text);}
  catch{
    const buffer=document.createElement('textarea');
    buffer.value=text;buffer.readOnly=true;buffer.className='clipboard-buffer';document.body.append(buffer);buffer.select();
    const copied=document.execCommand('copy');buffer.remove();
    if(!copied)throw new Error('無法複製，請手動選取文字。');
  }
  confirmButton(button);
}

// The active navigation pill glides between items. Geometry is applied through
// the CSSOM, which the dashboard's style-src CSP permits.
export function navIndicator(nav){
  const pill=nav?.querySelector('.nav-indicator');if(!pill)return;
  const place=instant=>{
    const active=nav.querySelector('.nav.active');
    pill.classList.toggle('instant',instant);
    if(!active){pill.classList.add('gone');return;}
    pill.classList.remove('gone');
    pill.style.width=`${active.offsetWidth}px`;pill.style.height=`${active.offsetHeight}px`;
    pill.style.transform=`translate(${active.offsetLeft}px,${active.offsetTop}px)`;
  };
  new MutationObserver(()=>place(false)).observe(document.body,{attributes:true,attributeFilter:['data-page']});
  new ResizeObserver(()=>place(true)).observe(nav);
  place(true);
}
