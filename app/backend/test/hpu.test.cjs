const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getFieldMapping } = require('../lib/fieldmap');
const { validatePlcConfig } = require('../lib/validate');
const catalog = require('../../shared/db119Catalog.json');
const analytics = import('../../shared/hpuAnalytics.mjs');

test('all 391 imported tags retain unique raw names, addresses and mappings', () => {
  assert.equal(catalog.length,391);
  assert.equal(new Set(catalog.map(t=>t.name)).size,391);
  assert.equal(new Set(catalog.map(t=>t.address)).size,391);
  for(const t of catalog) assert.deepEqual(getFieldMapping(t.name),{meas:t.measurement,field:t.field});
  assert.equal(catalog.find(t=>t.field==='discharge_pressure').address,'DB119.R12');
  assert.equal(catalog.find(t=>t.field==='aux_pressure').address,'DB119.R18');
  assert.equal(catalog.find(t=>t.measurement==='cat_engine_2'&&t.field==='rpm').address,'DB119.R428');
  assert.equal(catalog.find(t=>t.field==='fan5_currmotorcurrent'),undefined);
});
test('PLC defaults validate and contain each imported address once',()=>{
 const config=require('../defaults/plc_config.json');
 validatePlcConfig(config);
 const tags=config.slaves.flatMap(s=>s.metrics||[]).filter(m=>['CAT ENG-1','CAT ENG-2','HPU'].includes(m.tags?.equipment)).flatMap(m=>m.fields);
 assert.equal(tags.length,391);
 for(const t of catalog)assert.ok(tags.some(f=>f.name===t.name&&f.address===t.address));
 assert.throws(()=>validatePlcConfig({...config,hpuAnalytics:{ratedFlows:{pdw_pump1_1:-1}}}));
});
test('missing values and booleans never become analog zero',async()=>{
 const a=await analytics;
 for(const v of [null,undefined,'',true,false,NaN,Infinity])assert.equal(a.number(v),null);
 assert.equal(a.number(0),0);
 assert.equal(a.completeSum([1,null]),null);
 assert.equal(a.tracking(3,0),null);
});
test('sensor failure and individual stale timestamps invalidate live readings',async()=>{
 const a=await analytics,now=Date.now();
 const p={hpu:{oil_temp:64,oil_temp_ok:true},_meta:{connected:true,stale:false},_fieldTimes:{'hpu.oil_temp':new Date(now).toISOString(),'hpu.oil_temp_ok':new Date(now).toISOString()}};
 assert.equal(a.reading(p,'oil_temp',{},now).value,64);
 p.hpu.oil_temp_ok=false;assert.equal(a.reading(p,'oil_temp',{},now).quality,'SENSOR BAD');
 p.hpu.oil_temp_ok=true;p._fieldTimes['hpu.oil_temp']=new Date(now-20000).toISOString();assert.equal(a.reading(p,'oil_temp',{},now).quality,'STALE');
});
test('stability uses sample variability and requires enough nonzero data',async()=>{
 const a=await analytics;
 assert.equal(a.stability([1,2]),null);assert.equal(a.stability(Array(10).fill(0)),null);
 assert.equal(a.stability(Array(10).fill(100)).score,100);
 assert.ok(a.stability(Array.from({length:10},(_,i)=>i%2?110:90)).score<100);
});
test('runtime utilization requires time coverage and explicit RUN state',async()=>{
 const a=await analytics,rows=Array.from({length:11},(_,i)=>({timestamp:i*1000,'hpu.status':i<5?2:0}));
 assert.equal(a.utilization(rows,0,10000,2000),50);
 assert.equal(a.utilization(rows.slice(7),0,10000,2000),null);
 assert.equal(a.utilization([{timestamp:0,'hpu.status':2},{timestamp:10000,'hpu.status':2}],0,10000,2000),null);
});
test('percent flow requires ratings and every physical pump before summing',async()=>{
 const a=await analytics,g=a.groups[0],values={},ratings={};
 for(const p of g.pumps){values[p+'_flow_pv']=50;values[p+'_flow_sp']=60;values[p+'_press_pv']=100;ratings[p]=200;}
 assert.equal(a.aggregateGroup(values,g).flow,null);
 assert.equal(a.aggregateGroup(values,g,ratings).flow,400);
 assert.equal(a.aggregateGroup(values,g,ratings).flowSp,480);
 values[g.pumps[0]+'_flow_pv']=null;assert.equal(a.aggregateGroup(values,g,ratings).flow,null);
});
test('fan availability cannot claim healthy when diagnostic fields are missing',async()=>{
 const a=await analytics,v={};assert.equal(a.healthyFanAvailability(v),null);
 for(let i=1;i<=6;i++){v['fan'+i+'_ready']=true;v['fan'+i+'_groupfault']=false;v['fan'+i+'_groupwarning']=false;}
 assert.equal(a.healthyFanAvailability(v),100);v.fan3_groupfault=true;assert.equal(a.healthyFanAvailability(v),5/6*100);
});
