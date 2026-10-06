// The pinned Talk/Square SDK persists reqseq before calling request.request.
// Authorize at that RPC boundary, after the asynchronous storage acknowledgment.
// Per-operation views leave concurrent polling and other live RPCs untouched.
export function dispatchText(client,chat,options,beforeDispatch){
  const original=chat.kind==='openchat'?client.square:client.talk;
  const service=Object.create(original),view=Object.create(client),request=Object.create(client.request??null);
  service.client=view;view.request=request;
  // Keep sequence allocation on the real client, including its shared cache.
  view.getReqseq=(...args)=>client.getReqseq(...args);
  request.request=async(...args)=>{
    await beforeDispatch();
    return client.request.request(...args);
  };
  return service.sendMessage(options);
}
