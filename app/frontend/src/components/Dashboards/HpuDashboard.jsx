import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, Legend, LabelList } from 'recharts';
import { Gauge, Activity, Clock, Thermometer, Droplets, Fan, AlertCircle as CircleAlert, CheckCircle2, Info } from 'lucide-react';
import api from '../../api';
import { socket, getLatestRigData } from '../../socket';
import catalog from '../../../../shared/db119Catalog.json';
import { number, bit, reading, lines, groups, qualityFields, completeSum, tracking, stability, utilization, aggregateGroup, healthyFanAvailability } from '../../../../shared/hpuAnalytics.mjs';
import './HpuDashboard.css';

const TABS=['Overview','Pressure Network','Pump Groups','Cooling & Health'];
const RANGES=['1m','5m','15m','30m','1h','2h','4h','8h','24h'];
const COLORS=['#03ef95','#00b8fa','#ffd500','#d82af9','#ff861a','#00e7ed','#73a4fc','#ef74bd','#a5ffd3','#bdcfff','#fbf4a5','#7876ff'];
const HP_TAGS=catalog.filter(t=>t.measurement==='hpu');
const motorLabels={readystartmotoron:'Ready Start',motoron:'Motor On',motorcw:'Motor CW',motorccw:'Motor CCW',groupfault:'Group Fault',groupwarning:'Group Warning',quickstopactive:'Quick Stop',energysavemodeactive:'Energy Save',overtemperature:'Overtemperature',thermmotormodeloverload:'Thermal Overload',exmotorprotection:'EX Protection',currentlimittripping:'Current Limit Trip',residualcurrentdetected:'Residual Current',asymmetrydetected:'Asymmetry',ready:'Ready'};
const label=k=>motorLabels[k]||k.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/auxiliarypump/gi,'Auxiliary Pump').replace(/servicepump/gi,'Service Pump').replace(/pulldownpump/gi,'PullDown Pump ').replace(/topdrivepump/gi,'TopDrive Pump ').replace(/ventds/gi,'Vent DS').replace(/ventods/gi,'Vent ODS');
const fmt=(v,d=1)=>number(v)===null?'--':Number(v).toLocaleString(undefined,{maximumFractionDigits:d});
const status=(v,map)=>v==null?'--':map[v]??('CODE '+v);
const hpuStatus={0:'OFF',1:'IDLE',2:'RUNNING'};
const pumpName=p=>p.replace(/^pdw_/, 'PDW ').replace(/^htd_/, 'HTD ').replace(/^srv_/, 'SRV ').replace(/pump(\d)(?:_(\d))?/,(_,a,b)=>'Pump '+a+(b?'.'+b:''));
const PumpState=({value})=><span className={'hpu-badge '+(value==null?'muted':value===2?'good':'muted')}><i/>{status(value,pumpStatus)}</span>;
const pumpStatus={0:'NOT READY',1:'READY',2:'ENABLED'};
const oilStates={0:'OK',1:'LOW',2:'HIGH',3:'HIGH-HIGH'};
const levelStates={0:'OK',1:'LOW-LOW',2:'LOW',3:'HIGH'};
const outputKeys=['auxiliarypump_sh01','servicepump_sh02','pulldownpump1_sh03','pulldownpump2_sh04','topdrivepump1_sh05','topdrivepump2_sh06','t67ebds_sh07','ventds_sh15','ventods_sh16','auxiliarypump_sh08','servicepump_sh09','pulldownpump1_sh10','pulldownpump2_sh11','topdrivepump1_sh12','topdrivepump2_sh13','t67ebds_sh14','ventds_sh17','ventods_sh18'];
const motorKeys=['ready','readystartmotoron','motoron','motorcw','motorccw','groupfault','groupwarning','quickstopactive','energysavemodeactive','overtemperature','thermmotormodeloverload','exmotorprotection','currentlimittripping','residualcurrentdetected','asymmetrydetected'];
const Panel=({title,children,className='',right})=><section className={'hpu-panel '+className}><header><h2>{title}</h2>{right}</header>{children}</section>;
const Badge=({value,on='ON',off='OFF',fault=false})=>{const b=bit(value);return <span className={'hpu-badge '+(b===null?'muted':b?(fault?'bad':'good'):['BAD','NOT OK'].includes(off)?'bad':'muted')}><i/>{b===null?'--':b?on:off}</span>};
const Table=({headers,children})=><div className="hpu-table-wrap"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
const Tile=({title,value,unit,quality})=><div className="hpu-tile"><span>{title}</span><div><strong>{value}</strong></div><small>{quality&&quality!=='GOOD'?quality:unit}</small></div>;
function HealthGauge({title,value,color='#00e4e7',note}) {
 const v=number(value);
 return <div className="hpu-gauge" title={note}><svg viewBox="0 0 120 112"><circle cx="60" cy="56" r="44" fill="none" stroke="#293e55" strokeWidth="12"/>{v!==null&&<circle cx="60" cy="56" r="44" fill="none" stroke={color} strokeWidth="12" strokeDasharray={Math.max(0,Math.min(100,v))*2.765+' 276.5'} transform="rotate(-90 60 56)" strokeLinecap="round"/>}<text x="60" y="58" textAnchor="middle" fill="#eef7ff" fontSize="23" fontWeight="800">{v===null?'--':Math.round(v)+'%'}</text></svg><b>{title}</b><small>{v===null?'INSUFFICIENT DATA':note||''}</small></div>;
}
function TrendPanel({title,rows,series,range,setRange,error}) {
 const units=[...new Set(series.map(s=>s.unit))];
 return <Panel title={title} className="hpu-trends" right={<div className="hpu-ranges">{RANGES.map(r=><button key={r} className={range===r?'selected':''} onClick={()=>setRange(r)}>{r.toUpperCase()}</button>)}</div>}>
 <div className="hpu-chart">{error?<div className="hpu-empty">{error}</div>:rows.length?<ResponsiveContainer width="100%" height="100%"><LineChart data={rows}><CartesianGrid stroke="#123149"/><XAxis dataKey="timestamp" type="number" domain={['dataMin','dataMax']} scale="time" tickFormatter={v=>new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} stroke="#89aec9" tick={{fontSize:10}} minTickGap={30}/>{units.map((u,i)=><YAxis key={u} yAxisId={u} orientation={i===0?'left':'right'} unit={' '+u} width={u==='L/min'?60:48} stroke={COLORS[i]} tick={{fontSize:10}}/>)}
 <Tooltip contentStyle={{background:'#061c2d',borderColor:'#146188'}} labelFormatter={v=>new Date(v).toLocaleString()} formatter={(v,n)=>[fmt(v),n]}/>
 {series.map((s,i)=><Line key={s.key} dataKey={s.key} name={s.name+' ('+s.unit+')'} yAxisId={s.unit} stroke={COLORS[i%COLORS.length]} dot={false} strokeWidth={1.7} connectNulls={false} isAnimationActive={false}/>)}</LineChart></ResponsiveContainer>:<div className="hpu-empty">No recorded samples in this time window</div>}</div>
 <div className="hpu-legend">{series.map((s,i)=><span key={s.key}><i style={{background:COLORS[i%COLORS.length]}}/>{s.name} <b>{fmt(rows.at(-1)?.[s.key])}</b> {s.unit}</span>)}</div></Panel>;
}
const PumpGroupTick=({x,y,payload})=><text x={x} y={y+17} textAnchor="middle" fill="#c3d9ee" fontSize={12}><tspan x={x} fontWeight={600}>{payload.value}</tspan><tspan x={x} dy={16}>{({PDW:'(PullDown)',HTD:'(Top Drive)',SRV:'(Service /'})[payload.value]}</tspan>{payload.value==='SRV'&&<tspan x={x} dy={15}>Auxiliary)</tspan>}</text>;
function PumpFlowComparison({values,ratings}) {
 const data=groups.map(g=>({name:g.id.toUpperCase(),...aggregateGroup(values,g,ratings)}));
 const missingRatings=groups.some(g=>g.pumps.some(p=>!(number(ratings?.[p])>0)));
 const missingData=data.some(d=>d.flow===null||d.flowSp===null);
 const maximum=Math.max(0,...data.flatMap(d=>[number(d.flowSp)??0,number(d.flow)??0]));
 const rawStep=(maximum>0?maximum*1.15:100)/5;
 const magnitude=10**Math.floor(Math.log10(rawStep));
 const step=([1,2,2.5,5,10].find(v=>v>=rawStep/magnitude)??10)*magnitude;
 const axisTicks=Array.from({length:6},(_,i)=>Number((i*step).toPrecision(12)));
 return <Panel title="Pump Group Flow Comparison" className="hpu-flow-comparison">
 <div className="hpu-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{top:16,right:22,bottom:12,left:18}} barGap={5} barCategoryGap="25%">
 <CartesianGrid stroke="#123b55" vertical horizontal/>
 <XAxis dataKey="name" stroke="#00bdf2" tick={<PumpGroupTick/>} height={64} interval={0} tickLine={false} axisLine={{stroke:'#00bdf2'}}/>
 <YAxis stroke="#00bdf2" tick={{fill:'#c3d9ee',fontSize:12}} tickMargin={8} width={64} domain={[0,axisTicks[5]]} ticks={axisTicks} interval={0} tickFormatter={v=>Math.abs(v)>=10000?fmt(v/1000)+'k':fmt(v)} label={{value:'Flow (L/min)',angle:-90,position:'insideLeft',offset:-8,fill:'#c3d9ee',fontSize:12}}/>
 <Tooltip contentStyle={{background:'#061c2d',borderColor:'#146188'}} formatter={(v,n)=>[fmt(v)+' L/min',n]}/>
 <Legend verticalAlign="top" align="right" height={27} iconType="square" iconSize={12} wrapperStyle={{fontSize:10,paddingRight:8}}/>
 <Bar dataKey="flowSp" name="Flow SP" fill="#00b9ef" maxBarSize={42} isAnimationActive={false}><LabelList dataKey="flowSp" position="top" fill="#eaf3ff" fontSize={11} formatter={v=>number(v)===null?'':fmt(v)}/></Bar>
 <Bar dataKey="flow" name="Flow PV" fill="#0865fa" maxBarSize={42} isAnimationActive={false}><LabelList dataKey="flow" position="top" fill="#eaf3ff" fontSize={11} formatter={v=>number(v)===null?'':fmt(v)}/></Bar>
 </BarChart></ResponsiveContainer></div>
 {missingData&&<small className="hpu-flow-note">{missingRatings?'Configure rated pump capacities to calculate L/min.':'Waiting for valid PLC flow values.'}</small>}
 </Panel>;
}
function AlarmTable({events,title}) {
 const [type,setType]=useState('ALL');
 const source=e=>{const k=e.key||'';return /fan\d/.exec(k)?.[0]?.replace('fan','Fan ')||/(pdw|htd|srv)_pump\d(?:_\d)?/.exec(k)?.[0]?.toUpperCase()||(/m99/.test(k)?'M99':/oil/.test(k)?'Oil System':'HPU');};
 const shown=events.filter(e=>type==='ALL'||e.type===type);
 return <Panel title={title} right={<select aria-label="Event type" value={type} onChange={e=>setType(e.target.value)}><option value="ALL">All Types</option>{[...new Set(events.map(e=>e.type))].map(t=><option key={t}>{t}</option>)}</select>}>
 <Table headers={['Time','Type','Source','Description','Status']}>{shown.slice(0,8).map((e,i)=><tr key={e.ts+e.key+i}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.type}</td><td>{source(e)}</td><td>{e.label||e.key}</td><td>{e.type==='ACK'?'ACKNOWLEDGED':e.type?.startsWith('RTN')?'CLEARED':e.type==='RAISE'?'RAISED':'RECORDED'}</td></tr>)}</Table>{!shown.length&&<div className="hpu-empty compact">No recorded HPU events</div>}</Panel>;
}
function InsightTable({insights,overview=false,pump=false,observedAt}) {
 if(pump) return <Panel title="Operational Insights & Recommendations" className="hpu-pump-insights"><Table headers={['Type','Description','Recommendation','Time']}>{insights.slice(0,6).map((s,i)=><tr key={i}><td><span className={'hpu-badge '+(s.kind==='bad'?'bad':'good')}><Info size={16}/>{s.kind==='bad'?'ALERT':'INFO'}</span></td><td>{s.title}</td><td>{s.text}</td><td>{Number.isFinite(Date.parse(observedAt))?new Date(observedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'--'}</td></tr>)}</Table>{!insights.length&&<div className="hpu-empty compact">Awaiting valid PLC values to assess operating conditions</div>}</Panel>;

 if(overview) return <Panel title="Operational Insights & Recommendations" className="hpu-insights hpu-overview-insights"><div className="hpu-overview-insight-rows">{insights.length?insights.map((s,i)=><div className={'hpu-overview-insight '+s.kind} key={i}>{s.kind==='bad'?<CircleAlert size={19}/>:s.kind==='good'?<CheckCircle2 size={19}/>:<Info size={19}/>}<strong>{s.kind==='bad'?'ALERT':'INFO'}</strong><b>{s.title}</b><span>{s.text}</span><time title="PLC observation time">{Number.isFinite(Date.parse(observedAt))?new Date(observedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'--'}</time></div>):<div className="hpu-empty compact">Awaiting valid PLC values to assess operating conditions</div>}</div></Panel>;
 return <Panel title="Operational Insights & Recommendations" className="hpu-insights">{insights.length?insights.slice(0,6).map((s,i)=><div className={'hpu-insight '+s.kind} key={i}>{s.kind==='bad'?<CircleAlert size={20}/>:s.kind==='good'?<CheckCircle2 size={20}/>:<Info size={20}/>}<b>{s.title}</b><span>{s.text}</span></div>):<div className="hpu-empty compact">Awaiting valid PLC values to assess operating conditions</div>}</Panel>;
}
export default function HpuDashboard() {
 const [tab,setTab]=useState(0),[range,setRange]=useState('1h'),[payload,setPayload]=useState(()=>getLatestRigData()),[now,setNow]=useState(Date.now());
 const [config,setConfig]=useState({}),[history,setHistory]=useState([]),[events,setEvents]=useState([]),[error,setError]=useState('');
 useEffect(()=>{const onData=p=>setPayload(p);const onDisconnect=()=>setPayload(p=>({...p,_meta:{...p?._meta,connected:false,stale:true}}));socket.on('rig_data',onData);socket.on('disconnect',onDisconnect);const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{socket.off('rig_data',onData);socket.off('disconnect',onDisconnect);clearInterval(timer)}},[]);
 useEffect(()=>{let active=true;const refresh=async()=>{try{const [c,e]=await Promise.all([api.get('/api/config/plc'),api.get('/api/alarms/history?limit=500')]);if(active){setConfig(c.data.hpuAnalytics||{});setEvents(e.data.filter(x=>/^hpu/i.test(x.key||'')||/HPU/i.test(x.label||'')))}}catch{}};refresh();const t=setInterval(refresh,30000);return()=>{active=false;clearInterval(t)}},[]);
 const readings=useMemo(()=>Object.fromEntries(HP_TAGS.map(t=>[t.field,reading(payload,t.field,config,now)])),[payload,config,now]);
 const values=useMemo(()=>Object.fromEntries(Object.entries(readings).map(([k,v])=>[k,v.value])),[readings]);
 const historyKeys=useMemo(()=> {
  const oil=['oil_temp','oil_level','oil_quality','sf_esch1_actoilflow','sf_esch2_actoilflow'];
  const pump=groups.flatMap(g=>g.pumps.flatMap(p=>[p+'_flow_sp',p+'_flow_pv',p+'_press_pv']));
  const keys=tab===2?pump:tab===1?lines.map(l=>l[0]):[...oil,'discharge_pressure','aux_pressure'];
  const selected=[...new Set([...keys,...lines.map(l=>l[0])])];
  return [...new Set([...selected,'status',...selected.map(k=>qualityFields[k]).filter(Boolean)])];
 },[tab]);
 useEffect(()=>{let active=true;const controller=new AbortController();let busy=false;
 const fetchHistory=async()=>{if(busy)return;busy=true;try{const batches=[];for(let i=0;i<historyKeys.length;i+=60)batches.push(historyKeys.slice(i,i+60));
 const responses=await Promise.all(batches.map(keys=>api.get('/api/history',{params:{range:'-'+range,metrics:keys.map(k=>'hpu.'+k).join(',')},signal:controller.signal})));
 const merged=new Map();responses.forEach(r=>r.data.forEach(row=>merged.set(row.timestamp,{...merged.get(row.timestamp),...row})));
 if(active){setHistory([...merged.values()].sort((a,b)=>a.timestamp-b.timestamp));setError('')}}catch(e){if(active&&!controller.signal.aborted){setHistory([]);setError('History unavailable — check InfluxDB connection')}}finally{busy=false}};
 setHistory([]);fetchHistory();const timer=setInterval(fetchHistory,15000);return()=>{active=false;controller.abort();clearInterval(timer)}},[range,historyKeys]);
 const rows=useMemo(()=>history.map(row=>{const out={timestamp:row.timestamp};for(const key of historyKeys){let v=number(row['hpu.'+key]);const q=qualityFields[key];if(q&&bit(row['hpu.'+q])!==true)v=null;const bounds=config.ranges?.[key];if(bounds&&v!==null&&((number(bounds.min)!==null&&v<bounds.min)||(number(bounds.max)!==null&&v>bounds.max)))v=null;out[key]=v;}
 for(const g of groups){const a=aggregateGroup(out,g,config.ratedFlows);out[g.id+'_flow']=a.flow;out[g.id+'_flow_sp']=a.flowSp;out[g.id+'_pressure']=a.pressure;}return out}),[history,historyKeys,config]);
 const flowTotal=completeSum(['sf_esch1_actoilflow','sf_esch2_actoilflow'].map(k=>number(config.ratedFlows?.[k])>0&&number(values[k])!==null?values[k]*config.ratedFlows[k]/100:null));
 const flowQuality=['sf_esch1_actoilflow','sf_esch2_actoilflow'].map(k=>readings[k]?.quality).find(q=>q!=='GOOD')||(['sf_esch1_actoilflow','sf_esch2_actoilflow'].every(k=>number(config.ratedFlows?.[k])>0)?'GOOD':'RATED FLOW REQUIRED');
 const stats=lines.map(([k])=>stability(rows.map(r=>r[k])));
 const availableStats=stats.filter(Boolean);
 const pressureScore=availableStats.length===12?availableStats.reduce((s,x)=>s+x.score,0)/availableStats.length:null;
 const duration=Number(range.slice(0,-1))*(range.endsWith('h')?3600000:60000);
 const histEnd=history.at(-1)?.timestamp??now;
 const gaps=history.slice(1).map((r,i)=>r.timestamp-history[i].timestamp).filter(x=>x>0).sort((a,b)=>a-b);
 const gap=Math.min(300000,(gaps[Math.floor(gaps.length/2)]||1000)*2.5);
 const util=utilization(history,histEnd-duration,histEnd,gap);
 const fanAvailability=healthyFanAvailability(values);
 const oilBits=['oil_temp_ok','oil_level_ok','oil_quality_ok','sf_esch1_actoilflowok','sf_esch2_actoilflowok'].map(k=>bit(values[k]));
 const oilScore=oilBits.every(v=>v!==null)&&['oil_temp','oil_level','oil_quality','sf_esch1_actoilflow','sf_esch2_actoilflow'].every(k=>number(values[k])!==null)&&values.oil_temp_status!==null&&values.oil_level_status!==null?100*(oilBits.filter(Boolean).length+(values.oil_temp_status===0?1:0)+(values.oil_level_status===0?1:0))/7:null;
 const pumpScores=groups.flatMap(g=>g.pumps).map(p=>{const f=tracking(values[p+'_flow_pv'],values[p+'_flow_sp']),pr=tracking(values[p+'_press_pv'],values[p+'_press_sp']);return f&&pr&&[0,1,2].includes(values[p+'_statuscode'])?(values[p+'_statuscode']===0?0:Math.max(0,100-(f.error+pr.error)/2)):null});
 const pumpHealth=pumpScores.every(x=>x!==null)?pumpScores.reduce((a,b)=>a+b,0)/pumpScores.length:null;
 const components={pressure:pressureScore,pumps:pumpHealth,oil:oilScore,cooling:fanAvailability,safety:bit(values.estopok)===null?null:bit(values.estopok)?100:0};
 const weights=config.healthWeights||{},weightSum=Object.keys(components).reduce((s,k)=>s+(number(weights[k])||0),0);
 const health=weightSum>0&&Object.entries(components).every(([k,v])=>v!==null&&number(weights[k])>0)?Object.entries(components).reduce((s,[k,v])=>s+v*weights[k],0)/weightSum:null;
 const insights=[];
 if(tab===2)for(const g of groups){const flowStats=stability(rows.map(r=>r[g.id+'_flow']));if(flowStats)insights.push({kind:'info',title:g.id.toUpperCase()+' flow stability',text:fmt(flowStats.score)+'% stability; variation σ '+fmt(flowStats.sd)+' L/min over the selected window.'});}
 for(const k of ['oil_temp','oil_level','oil_quality','sf_esch1_actoilflow','sf_esch2_actoilflow'])if(readings[k]?.quality==='SENSOR BAD')insights.push({kind:'bad',title:label(k)+' sensor fault',text:'PLC sensor OK bit is false. The measurement is excluded from calculations.'});
 for(const [k,name] of lines){const q=readings[k];if(q?.quality==='SENSOR BAD')insights.push({kind:'bad',title:name+' sensor fault',text:'PLC reports invalid pressure feedback. Inspect sensor and wiring.'});const t=tracking(values[k],config.pressureSetpoints?.[k]);if(t)insights.push({kind:'info',title:name+' pressure tracking',text:fmt(t.utilization)+'% of configured setpoint; deviation '+fmt(t.deviation)+' bar; error '+fmt(t.error)+'%.'});}
 if(values.oil_temp_status!==null)insights.unshift({kind:values.oil_temp_status>=2?'bad':'info',title:'Oil temperature: '+status(values.oil_temp_status,oilStates),text:fmt(values.oil_temp)+' °C. '+(values.oil_temp_status>=2?'Inspect cooling and oil circulation.':'Monitor PLC temperature status.')});
 if(values.oil_quality_ok!==null)insights.push({kind:bit(values.oil_quality_ok)?'good':'bad',title:'Oil quality sensor',text:bit(values.oil_quality_ok)?'Sensor valid; measured oil quality '+fmt(values.oil_quality)+'%.':'PLC reports invalid oil quality feedback.'});
 for(let i=1;i<=6;i++)if(bit(values['fan'+i+'_groupfault'])||bit(values['fan'+i+'_groupwarning']))insights.unshift({kind:'bad',title:'Cooling Fan '+i+' '+(bit(values['fan'+i+'_groupfault'])?'fault':'warning'),text:'Inspect motor starter diagnostics and cooling availability.'});
 if(bit(values.estopok)===false)insights.unshift({kind:'bad',title:'Emergency-stop circuit not OK',text:'Check the PLC safety diagnostics before operation.'});
 if(tab===2)for(const g of groups)for(const p of g.pumps){const f=tracking(values[p+'_flow_pv'],values[p+'_flow_sp']),pr=tracking(values[p+'_press_pv'],values[p+'_press_sp']);if(f&&pr)insights.unshift({kind:'info',title:label(p).toUpperCase(),text:'Flow tracking error '+fmt(f.error)+'%; pressure tracking error '+fmt(pr.error)+'%.'});}
 const metric=(key,title,unit,Icon)=><Tile key={key} title={title} value={fmt(values[key])} unit={unit} quality={readings[key]?.quality} icon={Icon}/>;
 const pressureCards=(count=12)=><div className={'hpu-pressure-cards '+(count===8?'eight':'')}>{lines.slice(0,count).map(([k,title,q])=><div className="hpu-pressure-card" key={k}><span>{title}</span><div><strong>{fmt(values[k])}</strong><small>bar</small></div><Badge value={values[q]} on="OK" off="BAD" fault={bit(values[q])===false}/>{readings[k]?.quality!=='GOOD'&&<small>{readings[k]?.quality}</small>}</div>)}</div>;
 const healthCards=()=> <div className="hpu-health-grid">{[
 ['StatusCode',status(values.status,hpuStatus)],['EStop',<Badge value={values.estopok} on="OK" off="NOT OK"/>],
 ['OilTemp Status',status(values.oil_temp_status,oilStates)],['OilQuality',<Badge value={values.oil_quality_ok} on="VALID" off="BAD"/>],
 ['OilLevel',status(values.oil_level_status,levelStates)],['Oil Test Status',status(values.oiltest_statuscode,{0:'NONE',1:'OFF',2:'ON',3:'FAULT'})],
 ['Mode Feedback',values.modefdbk==null?'--':'CODE '+values.modefdbk],['Command Feedback',values.cmdfdbk==null?'--':'CODE '+values.cmdfdbk]
 ].map(([k,v])=><div key={k}><span>{k}</span><strong>{v}</strong></div>)}</div>;
 const gauges=(cooling=false)=><Panel title="Runtime & Efficiency"><div className="hpu-gauges"><HealthGauge title="HPU Health" value={health} color="#00ed91" note="Configured weighted health; all components required"/><HealthGauge title={cooling?'Fan Availability':'Pressure Stability'} value={cooling?fanAvailability:pressureScore} note={cooling?'Ready, no fault or warning':'100 − coefficient of variation (%)'}/><HealthGauge title="Utilization" value={util} color="#05b7f1" note="Time in RUN / valid observed time"/></div><div className="hpu-summary"><span><b>{fmt(values.run_hours)} h</b>Running Hours</span><span><b>{fmt(flowTotal)} L/min</b>Total Oil Flow</span><span><b>{fmt(values.discharge_pressure)} bar</b>Discharge</span><span><b>{fmt(values.aux_pressure)} bar</b>Auxiliary</span></div></Panel>;
 const oilSeries=[{key:'oil_temp',name:'Oil Temp',unit:'°C'},{key:'oil_level',name:'Oil Level',unit:'%'},{key:'oil_quality',name:'Oil Quality',unit:'%'},{key:'sf_esch1_actoilflow',name:'ESCH1 Flow',unit:'%'},{key:'sf_esch2_actoilflow',name:'ESCH2 Flow',unit:'%'}];
 const pressureSeries=lines.map(([key,name])=>({key,name,unit:'bar'}));
 const trend=(title,series)=><TrendPanel {...{title,rows,series,range,setRange,error}}/>;
 const fanCount=field=>{const bits=Array.from({length:6},(_,i)=>bit(values['fan'+(i+1)+'_'+field]));return bits.every(v=>v!==null)?bits.filter(Boolean).length:null};
 return <div className={'hpu-analytics '+['hpu-overview','hpu-pressure','hpu-pumps','hpu-cooling'][tab]}>
 <div className="hpu-heading"><nav aria-label="HPU views" role="tablist">{TABS.map((name,i)=><button key={name} role="tab" aria-selected={tab===i} className={tab===i?'selected':''} onClick={()=>setTab(i)}>{name}</button>)}</nav></div>
 <div className="hpu-kpis"><Tile title="HPU Status" value={status(values.status,hpuStatus)} quality={readings.status?.quality} icon={Activity}/>{metric('run_hours','Running Hours','h',Clock)}{metric('oil_temp','Oil Temperature','°C',Thermometer)}{metric('oil_quality','Oil Quality','%',Droplets)}{metric('oil_level','Oil Level','%',Droplets)}<Tile title="Oil Flow" value={fmt(flowTotal)} unit="L/min" quality={flowQuality} icon={Activity}/>{metric('discharge_pressure','Discharge Line','bar')}{metric('aux_pressure','Auxiliary Line','bar')}{metric('bpoilreturnlines','Return Line','bar')}<Tile title="Cooling Fan Status" value={values.coolingfan_statuscode==null?'--':'CODE '+values.coolingfan_statuscode} quality={readings.coolingfan_statuscode?.quality} icon={Fan}/></div>
 <div role="tabpanel" aria-label={TABS[tab]}>
 {tab===0&&<><div className="hpu-grid two hpu-overview-status-row"><Panel title="HPU General & Oil Health">{healthCards()}</Panel><Panel title="Pressure Network Snapshot">{pressureCards(8)}</Panel></div><div className="hpu-grid trend-runtime hpu-overview-trend-row">{trend('Real-Time Trends (Last '+(range.endsWith('h')?range.slice(0,-1)+' Hour'+(range==='1h'?'':'s'):range.slice(0,-1)+' Minutes')+')',[oilSeries[0],oilSeries[1],...pressureSeries.slice(0,2),...oilSeries.slice(3)])}{gauges()}</div><InsightTable insights={insights} overview observedAt={payload?._meta?.ts}/></>}
 {tab===1&&<><div className="hpu-grid pressure-main"><div><Panel title="Pressure Network">{pressureCards()}</Panel>{trend('Pressure Trends',pressureSeries)}</div><Panel title="Line Utilization (vs Setpoint)"><Table headers={['Line','PV bar','SP bar','Utilization']}>{lines.map(([k,name])=>{const sp=config.pressureSetpoints?.[k],t=tracking(values[k],sp);return <tr key={k}><td>{name}</td><td>{fmt(values[k])}</td><td>{number(sp)>0?fmt(sp):'CONFIGURATION REQUIRED'}</td><td>{t?<><div className="hpu-bar"><i style={{width:Math.min(t.utilization,100)+'%'}}/></div>{fmt(t.utilization)}%</>:'--'}</td></tr>})}</Table></Panel></div><div className="hpu-grid three pressure-bottom"><Panel title="Pressure Stability"><div className="hpu-gauges">{[0,1,2].map(i=><HealthGauge key={i} title={lines[i][1]} value={stats[i]?.score} note={stats[i]?'σ '+fmt(stats[i].sd)+' bar':'10 valid samples required'}/>)}<HealthGauge title="Network" value={pressureScore}/></div></Panel><AlarmTable title="Pressure Alarms & Events" events={events.filter(e=>/pressure|sensor|discharge|aux|bpls|bpoil/i.test(e.label||e.key))}/><InsightTable insights={insights}/></div></>}
 {tab===2&&<><div className="hpu-grid three pump-top">{groups.map(g=><Panel key={g.id} title={g.label} className={'group-'+g.id}><Table headers={['Pump','Status','Flow SP %','Flow PV %','Press SP bar','Press PV bar','WL']}>{g.pumps.map(p=><tr key={p}><td>{pumpName(p)}</td><td><PumpState value={values[p+'_statuscode']}/></td><td>{fmt(values[p+'_flow_sp'])}</td><td>{fmt(values[p+'_flow_pv'])}</td><td>{fmt(values[p+'_press_sp'])}</td><td>{fmt(values[p+'_press_pv'])}</td><td><Badge value={values[p+'_wl_enable']}/><small>SP {fmt(values[p+'_wl_sp'])}</small></td></tr>)}</Table></Panel>)}</div><div className="hpu-grid pump-charts"><PumpFlowComparison values={values} ratings={config.ratedFlows}/>{trend('Flow vs Pressure Trends (Last '+range.toUpperCase()+')',groups.flatMap(g=>[{key:g.id+'_flow',name:g.id.toUpperCase()+' Flow',unit:'L/min'},{key:g.id+'_pressure',name:g.id.toUpperCase()+' Mean Pressure',unit:'bar'}]))}</div></>}
 {tab===3&&<><div className="hpu-grid cooling-top"><Panel title="Oil Health & Condition">{healthCards()}</Panel><Panel title="M99 Oil Test Motor Starter"><div className="hpu-motor">{motorKeys.map(k=><div key={k}><span>{label(k)}</span><Badge value={values['m99_'+k]} fault={/fault|warning|over|trip|protection|residual|asymmetry/.test(k)}/></div>)}</div><div className="hpu-current">Motor current <strong>{fmt(values.m99_currmotorcurrent)} %</strong></div></Panel><Panel title="Cooling Fan Array"><Table headers={['Fan','Motor On','Ready','Fault','Warning','Current']}>{Array.from({length:6},(_,i)=>'fan'+(i+1)).map(f=><tr key={f}><td>{f.replace('fan','Fan ')}</td>{['motoron','ready','groupfault','groupwarning'].map(k=><td key={k}><Badge value={values[f+'_'+k]} fault={k.includes('group')}/></td>)}<td>{fmt(values[f+'_currmotorcurrent'])}<small>{values[f+'_currmotorcurrent']!=null?'PLC units':''}</small></td></tr>)}</Table></Panel></div><div className="hpu-grid cooling-middle">{trend('Cooling & Oil Condition Trends',oilSeries)}<div><Panel title="Cooling Temperature Switches"><div className="hpu-grid two">{[1,2].map(n=><div key={n}><h3>Cooling {n}</h3>{['hotoil','coldoil','hoth2o','coldh2o'].map(k=><div className="hpu-switch" key={k}><span>{k.replace('oil',' Oil').replace('h2o',' H₂O')}</span><Badge value={values['cooling'+n+'_'+k]}/></div>)}</div>)}</div></Panel><Panel title="Cooling System Status"><div className="hpu-summary"><span><b>{fmt(fanAvailability)}%</b>Fan availability</span><span><b>{fmt(fanCount('motoron'),0)}/6</b>Active fans</span><span><b>{fmt(fanCount('groupwarning'),0)}</b>Warnings</span><span><b>{fmt(fanCount('groupfault'),0)}</b>Faults</span></div></Panel></div></div><div className="hpu-grid three cooling-bottom">{gauges(true)}<AlarmTable title="Maintenance / Alarms & Events" events={events}/><InsightTable insights={insights}/></div></>}
 </div>
 </div>;
}
