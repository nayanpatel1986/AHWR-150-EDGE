import React from 'react';
import { Box, TextField, Typography } from '@mui/material';
import { lines, groups } from '../../../../shared/hpuAnalytics.mjs';

export default function HpuAnalyticsSettings({config, onChange}) {
  const settings=config.hpuAnalytics || {};
  const set=(section,key,value)=>onChange({...config,hpuAnalytics:{...settings,[section]:{...settings[section],[key]:value===''?null:Number(value)}}});
  return <Box sx={{mb:3,p:2,border:'1px solid #17617d',borderRadius:1}}>
    <Typography variant="h6">HPU analytics configuration</Typography>
    <Typography variant="body2" sx={{mb:2,color:'text.secondary'}}>Pressure setpoints and rated flow capacities are optional engineering settings. Save &amp; Apply to store. Empty settings remain unavailable; source flow values are percentages.</Typography>
    <Box sx={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:1}}>{lines.map(([id,label])=><TextField key={id} size="small" type="number" label={label+' SP (bar)'} value={settings.pressureSetpoints?.[id]??''} inputProps={{min:0}} onChange={e=>set('pressureSetpoints',id,e.target.value)}/>)}</Box>
    <Typography sx={{my:1}}>Rated pump flow at 100% (L/min)</Typography>
    <Box sx={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:1}}>{groups.flatMap(g=>g.pumps).concat(['sf_esch1_actoilflow','sf_esch2_actoilflow']).map(id=><TextField key={id} size="small" type="number" label={id.replaceAll('_',' ').toUpperCase()} value={settings.ratedFlows?.[id]??''} inputProps={{min:0}} onChange={e=>set('ratedFlows',id,e.target.value)}/>)}</Box>
    <Typography sx={{my:1}}>Health score weights (all five components must be valid)</Typography>
    <Box sx={{display:'flex',gap:1,flexWrap:'wrap'}}>{['pressure','pumps','oil','cooling','safety'].map(id=><TextField key={id} size="small" type="number" label={id+' weight'} value={settings.healthWeights?.[id]??''} inputProps={{min:0}} onChange={e=>set('healthWeights',id,e.target.value)}/>)}</Box>
  </Box>;
}
