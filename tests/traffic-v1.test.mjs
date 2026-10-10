// Revision 1. Validate fresh public feeds, geographic filtering, routing payloads, and safe failures.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {TrafficData,parseSigns,parseChp,pacificTimestamp} from '../assistant/traffic-v1.mjs';
const now=Date.parse('2026-10-06T23:00:00Z');
const sign=(overrides={})=>({cms:{inService:'true',location:{route:'US-101',direction:'North',county:'San Mateo',nearbyPlace:'San Mateo',locationName:'Northbound 101 at Hillsdale',latitude:'37.55',longitude:'-122.29'},recordTimestamp:{recordDate:'2026-10-06',recordTime:'15:59:36'},message:{display:'1 Page (Normal)',messageTimestamp:{messageDate:'2026-10-06',messageTime:'15:56:09'},phase1:{phase1Line1:'SFO ARPT 11 MIN',phase1Line2:'SF DWNTWN 48 MIN'}},...overrides}});
test('Pacific timestamps handle summer and winter; only recent operating signs provide current travel times',()=>{
 assert.equal(pacificTimestamp('2026-10-06','15:59:36'),'2026-10-06T22:59:36.000Z');assert.equal(pacificTimestamp('2026-12-06','15:59:36'),'2026-12-06T23:59:36.000Z');
 const parsed=parseSigns({data:[sign(),sign({inService:'false'}),sign({message:{display:'Blank'}})]},{highway:101,direction:'north'},now);
 assert.equal(parsed.signs.length,1);assert.equal(parsed.signs[0].postedTravelTimes[1].minutes,48);assert.equal(parsed.signs[0].near,'San Mateo');
 assert.equal(parseSigns({data:[sign()]},{highway:280},now).signs.length,0);assert.equal(parseSigns({data:[sign()]},{direction:'south'},now).signs.length,0);
 assert.equal(parseSigns({data:[sign()]},{},now+30*60000).signs[0].postedTravelTimes.length,0);assert.equal(parseSigns({data:[sign()]},{},now-10*60000).signs[0].fresh,false);
 assert.throws(()=>parseSigns({},{},now),/unrecognized/);assert.throws(()=>parseSigns({data:[]},{highway:'101'},now),/valid/);
});
const incident=(id,location,point)=>`<Log ID="${id}"><LogTime>"Oct  6 2026  3:54PM"</LogTime><LogType>"1125-Traffic Hazard"</LogType><Location>"${location}"</Location><LocationDesc>"AT EXIT"</LocationDesc><Area>"Redwood City"</Area><LATLON>"${point}"</LATLON><LogDetails><details><DetailTime>"Oct  6 2026  3:57PM"</DetailTime><IncidentDetail>"not forwarded"</IncidentDetail></details></LogDetails></Log>`;
test('CHP is scoped by coordinates and highway, not incidental street numbers; unknown direction stays explicit',()=>{
 const xml='<State>'+incident('a','Us101 N / Whipple','37485000:122236000')+incident('b','I280 S / Exit','37485000:122236000')+incident('c','Us101 N / Exit','34000000:118000000')+incident('d','101 Main St','37485000:122236000')+'</State>';
 const {items}=parseChp(xml,{highway:101,direction:'north'},now);assert.equal(items.length,1);assert.equal(items[0].id,'a');assert.equal(items[0].direction,'north');assert.equal(items[0].longitude,-122.236);assert.equal(items[0].lastIncidentUpdate,'2026-10-06T22:57:00.000Z');assert(!JSON.stringify(items).includes('not forwarded'));
 assert.equal(parseChp(xml,{highway:101,direction:'south'},now).items.length,0);assert.throws(()=>parseChp('<!DOCTYPE evil><State></State>'),/unrecognized/);
});
test('direct sources disclose partial failure, missing freshness, and no routing key without inventing clear traffic',async()=>{
 let calls=0;const data=new TrafficData({now:()=>now,apiKey:'',fetch:async(url,options)=>{calls++;assert.equal(options.cache,'no-store');if(url.includes('chp'))throw Error('offline');return Response.json({data:[sign()]},{headers:{'last-modified':'Tue, 06 Oct 2026 22:59:36 GMT'}})}});
 const result=await data.conditions({highway:101});assert.equal(calls,2);assert.equal(result.sources[0].available,false);assert.equal(result.sources[1].feedFresh,true);assert.equal(result.sources[1].signs[0].postedTravelTimes.length,2);assert.equal(result.routingAvailable,false);assert.match(result.limitations,/never from the user/);
 const route=await data.route({origin:'Redwood City',destination:'SFO'});assert.equal(route.available,false);assert.equal(calls,2);
 const unknown=new TrafficData({now:()=>now,fetch:async()=>new Response('<State></State>')});assert.equal((await unknown.conditions({})).sources[0].feedFresh,false);
});
test('routing sends a traffic-aware request with bounded fields and never leaks provider errors or keys',async()=>{
 let calls=0;const data=new TrafficData({now:()=>now,apiKey:'secret-test-key',fetch:async(url,r)=>{calls++;assert.equal(url,'https://routes.googleapis.com/directions/v2:computeRoutes');assert.equal(r.headers['X-Goog-Api-Key'],'secret-test-key');assert.equal(r.headers['X-Goog-FieldMask'],'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description');const body=JSON.parse(r.body);assert.equal(body.routingPreference,'TRAFFIC_AWARE');assert.equal(body.origin.address,'Redwood City');assert.equal(body.destination.address,'SFO');return Response.json({routes:[{duration:'1800s',staticDuration:'1200s',distanceMeters:28000,description:'US-101 N'}]})}});
 const result=await data.route({origin:'Redwood City',destination:'SFO'});assert.equal(result.durationSeconds,1800);assert.equal(result.withoutTrafficSeconds,1200);assert(!JSON.stringify(result).includes('secret-test-key'));
 await assert.rejects(data.route({origin:'',destination:'SFO'}),/origin/);assert.equal(calls,1);
 data.fetch=async()=>Response.json({error:'secret-test-key'},{status:403});await assert.rejects(data.route({origin:'Redwood City',destination:'SFO'}),error=>/HTTP 403/.test(error.message)&&!error.message.includes('secret-test-key'));
});
test('cancellation stops both traffic fetches and never publishes an obsolete result',async()=>{
 const controller=new AbortController();const data=new TrafficData({fetch:async(_,r)=>new Promise((resolve,reject)=>r.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}))});
 const pending=data.conditions({},{signal:controller.signal});controller.abort();await assert.rejects(pending,/abort/i);
});
