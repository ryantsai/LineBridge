const loopback=address=>address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
const forwarded=name=>name==='forwarded'||name==='via'||name==='true-client-ip'||name==='x-real-ip'||name==='x-original-host'||name==='x-original-url'||name.startsWith('x-forwarded-')||name.startsWith('cf-');
export function browserRequest(req) {
  const h=req.headers;
  // Node's fetch sends Sec-Fetch-Mode: cors on its own. Browsers also send
  // Origin, Referer, Fetch-Site or Fetch-Dest; navigations use another mode.
  return ['origin','referer','sec-fetch-site','sec-fetch-dest'].some(name=>h[name]!==undefined)||(h['sec-fetch-mode']!==undefined&&h['sec-fetch-mode']!=='cors');
}

// Only the direct, server-side loopback client is trusted. Enabling any tunnel
// requires credentials on the entire listener, even when a proxy strips headers.
export function directLocalRequest(req,port,provider,requireToken=false) {
  if(requireToken||provider!=='local'||!loopback(req.socket?.remoteAddress))return false;
  if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host))return false;
  if(browserRequest(req))return false;
  return !Object.keys(req.headers).some(name=>forwarded(name.toLowerCase()));
}
