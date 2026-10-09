// Development-only isolated preview. Never included by the production entry.
import React from 'react';
import {createRoot} from 'react-dom/client';
import HpuDashboard from '../src/components/Dashboards/HpuDashboard';
import api from '../src/api';
import {socket} from '../src/socket';
import catalog from '../../shared/db119Catalog.json';
import {lines,groups} from '../../shared/hpuAnalytics.mjs';
let mode='empty';
const sample=()=>Object.fromEntries(catalog.filter(t=>t.measurement==='hpu').map(t=>[t.field,t.address.includes('.X')?!/fault|warning|high|hihi|hot|over|trip|residual|asymmetry|protection|quickstop/.test(t.field):t.field==='status'?2:t.field==='run_hours'?2340:t.field==='oil_temp'?64:t.field==='oil_level'?78:t.field==='oil_quality'?91:/status|modefdbk|cmdfdbk/.test(t.field)?0:/pressure|press_/.test(t.field)?185:63]));
const settings={pressureSetpoints:Object.fromEntries(lines.map(([k])=>[k,200])),ratedFlows:Object.fromEntries([...groups.flatMap(g=>g.pumps),'sf_esch1_actoilflow','sf_esch2_actoilflow'].map(k=>[k,200])),healthWeights:{pressure:30,pumps:25,oil:20,cooling:15,safety:10}};
api.defaults.adapter=async req=>{
 let data=[];
 if(req.url.includes('/config/plc'))data={hpuAnalytics:settings};
 if(req.url==='/api/history'&&mode!=='empty'){
  const v=sample(),metrics=req.params.metrics.split(','),end=Math.floor(Date.now()/15000)*15000;
  const range=req.params.range.slice(1),duration=parseInt(range)*(range.endsWith('h')?3600000:60000);
  data=Array.from({length:61},(_,i)=>({timestamp:end-duration+i*duration/60,...Object.fromEntries(metrics.map(k=>[k,v[k.slice(4)]]))}));
 }
 return {data,status:200,statusText:'OK',headers:{},config:req};
};
function publish(){const hpu=mode==='empty'?{}:sample();if(mode==='bad')hpu.oil_temp_ok=false;const payload={hpu,_meta:{connected:mode!=='empty',stale:mode==='stale'},_fieldTimes:Object.fromEntries(Object.keys(hpu).map(k=>['hpu.'+k,new Date().toISOString()]))};socket.listeners('rig_data').forEach(fn=>fn(payload));}
function Preview(){return <><div style={{background:'#473700',color:'#ffe791',padding:8,fontFamily:'Arial'}}>ISOLATED TEST PREVIEW — SYNTHETIC VALUES ONLY {['empty','sample','stale','bad'].map(m=><button key={m} onClick={()=>{mode=m;publish()}}>{m}</button>)}</div><HpuDashboard/></>}
createRoot(document.getElementById('root')).render(<Preview/>);setInterval(publish,1000);
