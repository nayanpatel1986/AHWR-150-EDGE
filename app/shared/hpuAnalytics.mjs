// Pure calculations shared by the dashboard and regression tests. No PLC polling.
export const number = v => v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export const bit = v => v === true || v === 1 ? true : v === false || v === 0 ? false : null;
export const lines = [
  ['discharge_pressure', 'Discharge Line', 'discharge_pressure_ok'], ['aux_pressure', 'Auxiliary Line', 'aux_pressure_ok'],
  ['bpoilreturnlines', 'Oil Return Line', 'bpoilreturnlinesok'], ['bplspiperack', 'Pipe Rack', 'bplspiperackok'],
  ['bplsbopcart', 'BOP Cart', 'bplsbopcartok'], ['bpcatwalk', 'Catwalk', 'bpcatwalkok'],
  ['bplsrigup', 'Rig-Up', 'bplsrigupok'], ['bplswalkways', 'Walkways', 'bplswalkwaysok'],
  ['bplsdcc lifting'.replace(' ', ''), 'DCC Lifting', 'bplsdcc liftingok'.replace(' ', '')],
  ['bplsauxwinch', 'Auxiliary Winch', 'bplsauxwinchok'], ['bplsservices', 'Services', 'bplsservicesok'],
  ['bphagglundsflushing', 'Hagglunds Flushing', 'bphagglundsflushingok']
];
export const groups = [
  { id: 'pdw', label: 'PDW — PullDown / Workover', pumps: ['pdw_pump1_1','pdw_pump1_2','pdw_pump2_1','pdw_pump2_2'] },
  { id: 'htd', label: 'HTD — Top Drive', pumps: ['htd_pump1_1','htd_pump1_2','htd_pump2_1','htd_pump2_2'] },
  { id: 'srv', label: 'SRV — Service / Auxiliary', pumps: ['srv_pump1','srv_pump2'] }
];
export const qualityFields = Object.fromEntries([
  ...lines.map(([k,,q])=>[k,q]), ['oil_temp','oil_temp_ok'], ['oil_level','oil_level_ok'], ['oil_quality','oil_quality_ok'],
  ['bpoiltest','bpoiltestok'], ['sf_esch1_actoilflow','sf_esch1_actoilflowok'], ['sf_esch2_actoilflow','sf_esch2_actoilflowok'],
  ...groups.flatMap(g=>g.pumps.flatMap(p=>[[p+'_flow_pv',p+'_flow_pv_ok'],[p+'_press_pv',p+'_press_pv_ok']]))
]);
export function reading(payload, key, config = {}, now = Date.now()) {
  const value = payload?.hpu?.[key];
  const meta = payload?._meta;
  const ts = Date.parse(payload?._fieldTimes?.['hpu.'+key]);
  const age = now - ts;
  if (value === undefined || value === null) return { value: null, quality: 'NO DATA' };
  if (!meta?.connected || meta.stale || !Number.isFinite(ts) || age > (config.staleMs || 10000) || age < -1000) return {value:null,quality:'STALE'};
  const q = qualityFields[key];
  if (q) {
    const qt = Date.parse(payload?._fieldTimes?.['hpu.'+q]);
    if (!Number.isFinite(qt) || now-qt > (config.staleMs || 10000)) return {value:null,quality:'STALE'};
    if (bit(payload.hpu[q]) !== true) return {value:null,quality:bit(payload.hpu[q])===false?'SENSOR BAD':'NO QUALITY'};
  }
  const n = typeof value === 'boolean' ? value : number(value);
  if (n === null) return {value:null,quality:'NO DATA'};
  const range = config.ranges?.[key];
  if (range && ((number(range.min)!==null && n<Number(range.min)) || (number(range.max)!==null && n>Number(range.max)))) return {value:null,quality:'OUT OF RANGE'};
  return {value:n,quality:'GOOD'};
}
export const completeSum = values => values.length && values.every(v=>number(v)!==null) ? values.reduce((a,b)=>a+Number(b),0) : null;
export function tracking(pv, sp) {
  pv=number(pv); sp=number(sp);
  return pv===null || sp===null || sp<=0 ? null : {deviation:pv-sp,error:Math.abs(pv-sp)/Math.abs(sp)*100,utilization:pv/sp*100};
}
export function stability(values, minSamples=10) {
  const v=values.map(number).filter(v=>v!==null);
  if(v.length<minSamples) return null;
  const mean=v.reduce((a,b)=>a+b,0)/v.length;
  if(Math.abs(mean)<0.001) return null;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/v.length);
  const cv=sd/Math.abs(mean)*100;
  return {score:Math.max(0,100-cv),sd,cv,samples:v.length};
}
export function utilization(rows, start, end, maxGapMs) {
  let valid=0, running=0;
  for(let i=0;i<rows.length-1;i++) {
    const a=rows[i], b=rows[i+1], state=number(a['hpu.status']);
    const dt=Math.min(end,b.timestamp)-Math.max(start,a.timestamp);
    if(![0,1,2].includes(state) || dt<=0 || b.timestamp-a.timestamp>maxGapMs) continue;
    valid+=dt; if(state===2) running+=dt;
  }
  return end>start && valid/(end-start)>=0.8 ? running/valid*100 : null;
}
export function aggregateGroup(values, group, ratings={}) {
  const flows=group.pumps.map(p=>number(values[p+'_flow_pv']));
  const commands=group.pumps.map(p=>number(values[p+'_flow_sp']));
  const calibrated=group.pumps.every(p=>number(ratings[p])>0);
  const flow=calibrated ? completeSum(flows.map((v,i)=>v===null?null:v*ratings[group.pumps[i]]/100)) : null;
  const flowSp=calibrated ? completeSum(commands.map((v,i)=>v===null?null:v*ratings[group.pumps[i]]/100)) : null;
  const pressures=group.pumps.map(p=>number(values[p+'_press_pv']));
  const sum=completeSum(pressures);
  return {flow,flowSp,pressure:sum===null?null:sum/pressures.length};
}
export function healthyFanAvailability(values) {
  const fans=Array.from({length:6},(_,i)=>'fan'+(i+1));
  if(fans.some(f=>['ready','groupfault','groupwarning'].some(k=>bit(values[f+'_'+k])===null))) return null;
  return fans.filter(f=>bit(values[f+'_ready']) && !bit(values[f+'_groupfault']) && !bit(values[f+'_groupwarning'])).length/6*100;
}
