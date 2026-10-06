// Shared by the browser, CLI and server. Never infer the host timezone.
export function instantMillis(value){
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)return null;
  const [,y,mo,d,h,mi,se,,zone]=match,year=Number(y),month=Number(mo),day=Number(d);
  const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>days[month-1]||Number(h)>23||Number(mi)>59||Number(se)>59)return null;
  if(zone!=='Z'&&(zone==='-00:00'||Number(zone.slice(1,3))>14||Number(zone.slice(4))>59||(Number(zone.slice(1,3))===14&&Number(zone.slice(4))!==0)))return null;
  const time=Date.parse(value);return Number.isFinite(time)?time:null;
}

export function validateTimeRange({startTime,endTime}){
  for(const [name,value] of Object.entries({startTime,endTime})){
    if(value!==undefined&&instantMillis(value)===null)throw new RangeError(`${name} requires YYYY-MM-DDTHH:mm:ss[.SSS] with Z or an explicit UTC offset (maximum ±14:00).`);
  }
  if(startTime!==undefined&&endTime!==undefined&&instantMillis(startTime)>=instantMillis(endTime))throw new RangeError('startTime must be earlier than endTime (start inclusive, end exclusive).');
  return {...(startTime===undefined?{}:{startTime}),...(endTime===undefined?{}:{endTime})};
}

export function formTimeRange(start,end,offset){
  if(!start&&!end)return {};
  const convert=value=>{
    if(!value)return undefined;
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))throw new RangeError('請輸入完整的日期與時間。');
    return (value.length===16?value+':00':value)+offset;
  };
  return validateTimeRange({startTime:convert(start),endTime:convert(end)});
}
