import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base=(process.env.LINE_BRIDGE_URL ?? 'http://127.0.0.1:3211').replace(/\/$/,'');
const headers=process.env.LINE_BRIDGE_TOKEN?{Authorization:`Bearer ${process.env.LINE_BRIDGE_TOKEN}`}:{ };
if(process.env.CF_ACCESS_CLIENT_ID)headers['CF-Access-Client-Id']=process.env.CF_ACCESS_CLIENT_ID;
if(process.env.CF_ACCESS_CLIENT_SECRET)headers['CF-Access-Client-Secret']=process.env.CF_ACCESS_CLIENT_SECRET;
const client=new Client({name:'line-bridge-example-agent',version:'0.1.0'});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));
  console.log('Available tools:',(await client.listTools()).tools.map(t=>t.name));
  const query=process.argv[2]==='search'?process.argv[3]:null;
  const result=await client.callTool(query?{name:'line_search_messages',arguments:{query}}:{name:'line_list_accounts',arguments:{}});
  for(const item of result.content ?? [])if(item.type==='text')console.log(item.text);
}finally{await client.close();}
