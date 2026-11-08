const UA='GlobalAtlas/1.0 (+https://github.com/starfirelockanddoorbackup-byte/global-atlas)';
async function g(name,url){try{const r=await fetch(url,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(30000)});const t=await r.text();console.log('\n##',name,r.status,t.length);console.log(t.slice(0,900))}catch(e){console.log('\n##',name,'ERR',e.message)}}
const PW='https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
await g('pw-list',PW+'?where=1%3D1&outFields=portid,portname&returnDistinctValues=true&returnGeometry=false&f=json');
await g('pw-stat',PW+"?where=portid%3D'chokepoint6'&outStatistics="+encodeURIComponent(JSON.stringify([{statisticType:'count',onStatisticField:'n_total',outStatisticFieldName:'c'}]))+'&f=json');
await g('pw-rows',PW+"?where=portid%3D'chokepoint6'&outFields=*&orderByFields=date%20DESC&resultRecordCount=3&f=json");
await g('pw-ports','https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_chokepoints_database/FeatureServer/0/query?where=1%3D1&outFields=portid,portname,lat,lon&returnGeometry=false&f=json');
await g('pw-disrupt','https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/portwatch_disruptions_database/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=2&orderByFields=fromdate%20DESC&returnGeometry=false&f=json');
await g('gdacs-arch','https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=DR&fromDate=2019-01-01&toDate=2026-11-08&alertlevel=Orange;Red&pagenumber=1');
await g('isc-hist','https://isc.sans.edu/api/porthistory/502/2026-10-01/2026-11-07?json');
await g('isc-hist102','https://isc.sans.edu/api/porthistory/102/2019-01-01/2019-01-05?json');
await g('ioda-year','https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?from=1704067200&until=1735689600&entityType=country&limit=300');
await g('yahoo-remx','https://query1.finance.yahoo.com/v8/finance/chart/REMX?range=6mo&interval=1d');
await g('yahoo-ttf','https://query1.finance.yahoo.com/v8/finance/chart/TTF%3DF?range=6mo&interval=1d');
await g('yahoo-ng','https://query1.finance.yahoo.com/v8/finance/chart/NG%3DF?range=6mo&interval=1d');
