// Content-free diagnostics for one OpenChat page. These explicit mappings are
// from the bundled lineclientbot 0.1.3 SquareEventType/SquareEventStatus enums.
// Never copy upstream strings, payloads, identifiers, or cursor values to output.
const eventTypes=Object.freeze({
  RECEIVE_MESSAGE:0,SEND_MESSAGE:1,NOTIFIED_JOIN_SQUARE_CHAT:2,
  NOTIFIED_INVITE_INTO_SQUARE_CHAT:3,NOTIFIED_LEAVE_SQUARE_CHAT:4,
  NOTIFIED_DESTROY_MESSAGE:5,NOTIFIED_MARK_AS_READ:6,
  NOTIFIED_UPDATE_SQUARE_MEMBER_PROFILE:7,NOTIFIED_UPDATE_SQUARE:8,
  NOTIFIED_UPDATE_SQUARE_STATUS:9,NOTIFIED_UPDATE_SQUARE_AUTHORITY:10,
  NOTIFIED_UPDATE_SQUARE_MEMBER:11,NOTIFIED_UPDATE_SQUARE_CHAT:12,
  NOTIFIED_UPDATE_SQUARE_CHAT_STATUS:13,NOTIFIED_UPDATE_SQUARE_CHAT_MEMBER:14,
  NOTIFIED_CREATE_SQUARE_MEMBER:15,NOTIFIED_CREATE_SQUARE_CHAT_MEMBER:16,
  NOTIFIED_UPDATE_SQUARE_MEMBER_RELATION:17,NOTIFIED_SHUTDOWN_SQUARE:18,
  NOTIFIED_KICKOUT_FROM_SQUARE:19,NOTIFIED_DELETE_SQUARE_CHAT:20,
  NOTIFICATION_JOIN_REQUEST:21,NOTIFICATION_JOINED:22,
  NOTIFICATION_PROMOTED_COADMIN:23,NOTIFICATION_PROMOTED_ADMIN:24,
  NOTIFICATION_DEMOTED_MEMBER:25,NOTIFICATION_KICKED_OUT:26,
  NOTIFICATION_SQUARE_DELETE:27,NOTIFICATION_SQUARE_CHAT_DELETE:28,
  NOTIFICATION_MESSAGE:29,NOTIFIED_UPDATE_SQUARE_CHAT_PROFILE_NAME:30,
  NOTIFIED_UPDATE_SQUARE_CHAT_PROFILE_IMAGE:31,NOTIFIED_UPDATE_SQUARE_FEATURE_SET:32,
  NOTIFIED_ADD_BOT:33,NOTIFIED_REMOVE_BOT:34,NOTIFIED_UPDATE_SQUARE_NOTE_STATUS:36,
  NOTIFIED_UPDATE_SQUARE_CHAT_ANNOUNCEMENT:37,NOTIFIED_UPDATE_SQUARE_CHAT_MAX_MEMBER_COUNT:38,
  NOTIFICATION_POST_ANNOUNCEMENT:39,NOTIFICATION_POST:40,MUTATE_MESSAGE:41,
  NOTIFICATION_NEW_CHAT_MEMBER:42,NOTIFIED_UPDATE_READONLY_CHAT:43,
  NOTIFIED_UPDATE_MESSAGE_STATUS:46,NOTIFICATION_MESSAGE_REACTION:47,
  NOTIFIED_CHAT_POPUP:48,NOTIFIED_SYSTEM_MESSAGE:49,NOTIFIED_UPDATE_SQUARE_CHAT_FEATURE_SET:50,
  NOTIFIED_UPDATE_LIVE_TALK:51,NOTIFICATION_LIVE_TALK:52,NOTIFIED_UPDATE_LIVE_TALK_INFO:53,
  NOTIFICATION_THREAD_MESSAGE:54,NOTIFICATION_THREAD_MESSAGE_REACTION:55,
  NOTIFIED_UPDATE_THREAD:56,NOTIFIED_UPDATE_THREAD_STATUS:57,NOTIFIED_UPDATE_THREAD_MEMBER:58,
  NOTIFIED_UPDATE_THREAD_ROOT_MESSAGE:59,NOTIFIED_UPDATE_THREAD_ROOT_MESSAGE_STATUS:60,
  NOTIFIED_CREATE_SQUARE_SUBSCRIPTION:61,NOTIFIED_UPDATE_SQUARE_SUBSCRIPTION:62
});
const eventStatuses=Object.freeze({NORMAL:1,ALERT_DISABLED:2});
const typeCodes=new Set(Object.values(eventTypes)),statusCodes=new Set(Object.values(eventStatuses));
const MAX_EVENTS=100,MAX_PAGE=1000000,MAX_ELAPSED_MS=86400000;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=value=>typeof value==='string'&&value.length>0;
function countEnum(counts,value,names,codes){
  const code=typeof value==='number'&&Number.isInteger(value)&&codes.has(value)?value:
    typeof value==='string'&&Object.hasOwn(names,value)?names[value]:'other';
  counts[code]=(counts[code]??0)+1;
}

/**
 * Return only bounded counts, booleans and elapsed milliseconds. eventCount and
 * all event-derived counts describe at most the first 100 events; eventsTruncated
 * marks an oversized response. recognizedMessageCount counts recognized payload
 * objects, not message text, valid IDs, distinct messages, or successful captures.
 * continuationTokenSent may be the request token or a precomputed boolean.
 * checkpointSucceeded stays false until the caller receives the storage ACK.
 */
export function squarePageDiagnostic({response,cursor,baseline,page,startedAt,continuationTokenSent}={}){
  const value=record(response)?response:{},events=Array.isArray(value.events)?value.events:[];
  const eventCount=Math.min(events.length,MAX_EVENTS),eventTypeCounts={},eventStatusCounts={};
  const cursorProvided=token(cursor),outputProvided=token(value.syncToken);
  let recognizedMessageCount=0,eventTokenEqualsInputCount=0,eventTokenEqualsOutputCount=0;
  for(let index=0;index<eventCount;index++){
    const event=record(events[index])?events[index]:{},payload=record(event.payload)?event.payload:{};
    countEnum(eventTypeCounts,event.type,eventTypes,typeCodes);
    countEnum(eventStatusCounts,event.eventStatus,eventStatuses,statusCodes);
    if(record(payload.receiveMessage)||record(payload.sendMessage)||record(payload.notificationMessage))recognizedMessageCount++;
    if(token(event.syncToken)){
      if(cursorProvided&&event.syncToken===cursor)eventTokenEqualsInputCount++;
      if(outputProvided&&event.syncToken===value.syncToken)eventTokenEqualsOutputCount++;
    }
  }
  const elapsed=typeof startedAt==='number'&&Number.isFinite(startedAt)?Date.now()-startedAt:0;
  return {
    page:typeof page==='number'&&Number.isSafeInteger(page)&&page>=0?Math.min(page,MAX_PAGE):0,
    elapsedMs:Math.min(MAX_ELAPSED_MS,Math.max(0,Math.floor(elapsed))),
    eventCount,eventsTruncated:events.length>MAX_EVENTS,recognizedMessageCount,eventTypeCounts,eventStatusCounts,
    cursorProvided,cursorChanged:cursorProvided&&outputProvided&&cursor!==value.syncToken,
    continuationPresent:token(value.continuationToken),
    continuationSent:continuationTokenSent===true||token(continuationTokenSent),
    eventTokenEqualsInputCount,eventTokenEqualsOutputCount,baselineBefore:baseline===true,checkpointSucceeded:false
  };
}
