// Isolated development fixture; never part of the production entry.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider,createTheme} from '@mui/material';
import CatEngineDashboard from '../src/components/Dashboards/CatEngineDashboard';
import api from '../src/api';
import {socket} from '../src/socket';
api.defaults.adapter=async req=>({data:[],status:200,statusText:'OK',headers:{},config:req});
function publish(){
 const payload={cat_engine:{rpm:1111,fuel_rate:11,load:21},cat_engine_2:{rpm:2222,fuel_rate:22,load:42},_meta:{connected:true,stale:false,source:'isolated-test'}};
 socket.listeners('rig_data').forEach(fn=>fn(payload));
}
createRoot(document.getElementById('root')).render(<ThemeProvider theme={createTheme({palette:{mode:'dark'}})}><div style={{color:'#ffd700',padding:8}}>ISOLATED TEST — SYNTHETIC ENGINE VALUES ONLY</div><CatEngineDashboard/></ThemeProvider>);
setInterval(publish,1000);
