// Node readline also splits on literal Unicode line and paragraph separators.
export function encodeWorkerMessage(value) {
  return JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:String(v)}:v)
    .replace(/[\u2028\u2029]/g,separator=>separator==='\u2028'?'\\u2028':'\\u2029');
}
export function decodeWorkerMessage(line) {
  return JSON.parse(line,(_,v)=>v&&typeof v==='object'&&'$bigint' in v?BigInt(v.$bigint):v);
}
