// Revision 1. Direct official traffic feeds and optional Google traffic-aware routing.
const CHP='https://media.chp.ca.gov/sa_xml/sa.xml';
const CMS='https://cwwp2.dot.ca.gov/data/d4/cms/cmsStatusD04.json';
const ROUTES='https://routes.googleapis.com/directions/v2:computeRoutes';
const limits={peninsula:[37.2,-122.56,37.83,-121.94],bay_area:[36.85,-123.6,38.9,-121.2],california:[32.5,-124.5,42.1,-114]};
const pt=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function pacificTimestamp(date,time){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^\d{2}:\d{2}:\d{2}$/.test(time||''))return null;
  const desired=Date.parse(`${date}T${time}Z`);let value=desired;
  for(let i=0;i<3;i++){const p=Object.fromEntries(pt.formatToParts(new Date(value)).map(x=>[x.type,x.value]));value+=desired-Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)}
  return new Date(value).toISOString();
}
function chpTimestamp(value){
  const m=/^(\w{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)$/.exec(value);if(!m)return null;
  const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[1])+1;if(!month)return null;
  return pacificTimestamp(`${m[3]}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`,`${String(Number(m[4])%12+(m[6]==='PM'?12:0)).padStart(2,'0')}:${m[5]}:00`);
}
function fresh(timestamp,now,minutes=10){const age=now-Date.parse(timestamp);return Number.isFinite(age)&&age>=-120000&&age<=minutes*60000}
const clean=value=>String(value||'').replace(/&(?:amp|lt|gt|quot|apos);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[s])).replace(/^"|"$/g,'').trim().slice(0,500);
const field=(xml,name)=>clean(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]);
function scoped(latitude,longitude,area){const [south,west,north,east]=limits[area];return Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=south&&latitude<=north&&longitude>=west&&longitude<=east}
function directionOf(text){const m=/\b([NSEW])(?:\s*\/\s*B|B|ORTH(?:BOUND)?|OUTH(?:BOUND)?|AST(?:BOUND)?|EST(?:BOUND)?)?\b/i.exec(text);return m?({N:'north',S:'south',E:'east',W:'west'})[m[1].toUpperCase()]:null}
function options(args={}){
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Provide traffic lookup options.');
  const {area='peninsula',highway,direction}=args;
  if(!Object.hasOwn(limits,area)||highway!==undefined&&(!Number.isInteger(highway)||highway<1||highway>999)||direction!==undefined&&!['north','south','east','west'].includes(direction))throw Error('Use a valid California area, highway number, and direction.');
  return {area,highway,direction};
}
export function parseChp(xml,args={},now=Date.now()){
  const {area,highway,direction}=options(args);if(!/<State>/.test(xml)||!/<\/State>/.test(xml)||/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('CHP returned an unrecognized feed.');
  const highwayPattern=highway?new RegExp(`\\b(?:US|SR|I|HWY|HIGHWAY)\\s*[- ]?\\s*${highway}\\b|\\b${highway}\\s*[NSEW]\\b`,'i'):null,items=[];
  for(const match of xml.matchAll(/<Log\s+ID\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/Log>/g)){
    const block=match[2],location=field(block,'Location'),description=field(block,'LocationDesc'),point=field(block,'LATLON').split(':').map(Number),latitude=point[0]/1e6,longitude=-Math.abs(point[1]/1e6);
    if(!scoped(latitude,longitude,area)||highwayPattern&&!highwayPattern.test(location))continue;
    const heading=directionOf(location+' '+description);if(direction&&heading&&direction!==heading)continue;
    const openedAt=chpTimestamp(field(block,'LogTime')),times=[...block.matchAll(/<DetailTime>([\s\S]*?)<\/DetailTime>/g)].map(m=>chpTimestamp(clean(m[1]))).filter(Boolean).sort();
    items.push({id:match[1],type:field(block,'LogType'),location,description,area:field(block,'Area'),direction:heading,openedAt,lastIncidentUpdate:times.at(-1)||openedAt,latitude,longitude});
  }
  items.sort((a,b)=>(b.lastIncidentUpdate||'').localeCompare(a.lastIncidentUpdate||''));
  return {items:items.slice(0,30),matchingCount:items.length,truncated:items.length>30};
}
export function parseSigns(json,args={},now=Date.now()){
  const {area,highway,direction}=options(args);if(!Array.isArray(json?.data))throw Error('Caltrans returned an unrecognized feed.');
  const signs=[];
  for(const row of json.data){
    const c=row.cms,l=c?.location,m=c?.message;if(!l||!m)continue;
    if(!scoped(Number(l.latitude),Number(l.longitude),area)||highway&&Number(l.route?.match(/\d+/)?.[0])!==highway||direction&&l.direction?.toLowerCase()!==direction)continue;
    if(c.inService!=='true'||m.display==='Blank')continue;
    const lines=[...[1,2,3].map(i=>clean(m.phase1?.[`phase1Line${i}`])),...[1,2,3].map(i=>clean(m.phase2?.[`phase2Line${i}`]))].filter(Boolean);if(!lines.length)continue;
    const observedAt=pacificTimestamp(c.recordTimestamp?.recordDate,c.recordTimestamp?.recordTime),messageChangedAt=pacificTimestamp(m.messageTimestamp?.messageDate,m.messageTimestamp?.messageTime),recordFresh=fresh(observedAt,now);
    const postedTravelTimes=recordFresh&&fresh(messageChangedAt,now,15)?lines.flatMap(line=>{const match=/^(.+?)\s+(\d+)(\+)?\s*MIN\b/.exec(line);return match?[{destination:match[1].trim(),minutes:Number(match[2]),atLeast:!!match[3]}]:[]}):[];
    signs.push({location:clean(l.locationName),near:clean(l.nearbyPlace),route:l.route,direction:l.direction,county:l.county,observedAt,messageChangedAt,fresh:recordFresh,lines,postedTravelTimes});
  }
  return {signs:signs.slice(0,30),matchingCount:signs.length,truncated:signs.length>30};
}
export const trafficTools=[{
  type:'function',name:'live_traffic',description:'Fetch current official CHP incidents and Caltrans Bay Area highway sign messages directly. Includes fresh sign-posted travel times where available. Select an explicit area and highway for the request. Specify the highway/direction when known; never treat sign-to-destination times as door-to-door ETA or incident absence as clear traffic.',strict:false,
  parameters:{type:'object',properties:{area:{type:'string',enum:['peninsula','bay_area','california']},highway:{type:'integer',minimum:1,maximum:999},direction:{type:'string',enum:['north','south','east','west']}},additionalProperties:false},
},{
  type:'function',name:'traffic_route',description:'Get a current traffic-aware driving estimate between two explicit addresses or places with Google Routes. Requires the host routing key. Ask for missing endpoints; never assume the user’s GPS location. Sends only those requested locations to Google.',strict:false,
  parameters:{type:'object',properties:{origin:{type:'string'},destination:{type:'string'}},required:['origin','destination'],additionalProperties:false},
}];
export class TrafficData {
  constructor({fetch:fetchImpl=fetch,apiKey=process.env.GOOGLE_MAPS_API_KEY||process.env.GOOGLE_ROUTES_API_KEY||'',now=Date.now}={}){Object.assign(this,{fetch:fetchImpl,apiKey,now})}
  get routingAvailable(){return !!this.apiKey.trim()}
  async read(url,{signal,...init}={}){
    const response=await this.fetch(url,{...init,cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`Traffic source unavailable (HTTP ${response.status}).`)}
    let bytes=0;const chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>3*1024*1024)throw Error('Traffic source returned too much data.');chunks.push(Buffer.from(chunk))}
    return {text:Buffer.concat(chunks).toString('utf8'),lastModified:response.headers.get('last-modified')};
  }
  async conditions(args,{signal}={}){
    const scope=options(args),now=this.now();
    const data=await Promise.allSettled([this.read(CHP,{signal}),this.read(CMS,{signal})]);signal?.throwIfAborted();
    const sources=data.map((result,index)=>{
      const source=index?'Caltrans highway signs':'CHP incidents',url=index?CMS:CHP;
      if(result.status==='rejected')return {source,url,available:false,error:'The live source could not be reached.'};
      try{
        const {text,lastModified}=result.value,sourceUpdatedAt=lastModified?new Date(lastModified).toISOString():null;
        return {source,url,available:true,sourceUpdatedAt,feedFresh:fresh(sourceUpdatedAt,now),...(index?parseSigns(JSON.parse(text),scope,now):parseChp(text,scope,now))};
      }catch{return {source,url,available:false,error:'The live source returned an unrecognized format.'}}
    });
    return {retrievedAt:new Date(now).toISOString(),scope,sources,routingAvailable:this.routingAvailable,limitations:'Caltrans signs cover District 4 only. Only fresh postedTravelTimes are current estimates, measured from the named sign to its displayed destination, never from the user or an arbitrary address. Disclose stale or unknown feed freshness. A sign can announce future closures; read its dates. CHP reports are incidents, not speed measurements; no incidents does not mean clear traffic.'};
  }
  async route({origin,destination}={}, {signal}={}){
    if(!this.routingAvailable)return {available:false,reason:'Traffic-aware door-to-door routing needs GOOGLE_MAPS_API_KEY with Google Routes API enabled. Live CHP incidents and Caltrans sign times remain available.'};
    if([origin,destination].some(v=>typeof v!=='string'||!v.trim()||v.length>300))throw Error('Provide an origin and destination, each under 300 characters.');
    const departureTime=new Date(this.now()).toISOString();
    const {text}=await this.read(ROUTES,{signal,method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':this.apiKey,'X-Goog-FieldMask':'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description'},body:JSON.stringify({origin:{address:origin},destination:{address:destination},travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',departureTime,computeAlternativeRoutes:false,languageCode:'en-US',units:'IMPERIAL'})});
    const route=JSON.parse(text).routes?.[0],seconds=value=>/^\d+(?:\.\d+)?s$/.test(value||'')?Number(value.slice(0,-1)):null;
    if(!route||seconds(route.duration)===null)throw Error('Google did not return a usable driving route.');
    return {available:true,source:'Google Maps Routes',sourceUrl:`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`,retrievedAt:new Date(this.now()).toISOString(),departureTime,origin,destination,durationSeconds:seconds(route.duration),withoutTrafficSeconds:seconds(route.staticDuration),distanceMeters:route.distanceMeters,description:route.description,trafficAware:true};
  }
}
