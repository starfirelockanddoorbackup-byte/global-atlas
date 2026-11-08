const UA='GlobalAtlas/1.0 (+https://github.com/starfirelockanddoorbackup-byte/global-atlas)';
const g=async(n,u,t=60000)=>{const s=Date.now();try{const r=await fetch(u,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(t)});const b=await r.text();console.log('##',n,r.status,b.length,((Date.now()-s)/1000).toFixed(1)+'s');console.log(b.slice(0,500).replace(/\n/g,' '));return b}catch(e){console.log('##',n,'ERR',e.message)}};
await g('fr-weekly','https://www.federalregister.gov/api/v1/documents/facets/weekly?conditions[agencies][]=federal-energy-regulatory-commission&conditions[type][]=RULE&conditions[type][]=PRORULE&conditions[type][]=PRESDOCU&conditions[publication_date][gte]=2019-01-01');
await g('fr-monthly','https://www.federalregister.gov/api/v1/documents/facets/monthly?conditions[term]=cybersecurity&conditions[type][]=RULE&conditions[publication_date][gte]=2019-01-01');
const d=await g('isc-long','https://isc.sans.edu/api/porthistory/502/2019-01-01/2026-11-07?json');
await g('gdacs-fl','https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=FL&fromDate=2019-01-01&toDate=2026-11-08&alertlevel=Orange;Red&pagenumber=1');
await g('gdacs-tc','https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromDate=2019-01-01&toDate=2026-11-08&alertlevel=Orange;Red&pagenumber=1');
const y=await g('yahoo-5y','https://query1.finance.yahoo.com/v8/finance/chart/ITA?range=5y&interval=1d');try{const r=JSON.parse(y).chart.result[0];console.log('5y bars',r.timestamp.length,new Date(r.timestamp.at(-1)*1000).toISOString())}catch(e){}
await g('gdelt-3m','https://api.gdeltproject.org/api/v2/doc/doc?query=%22power%20outage%22%20OR%20blackout&mode=timelinevolraw&timespan=3months&format=json');
await g('ioda-q','https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary?from=1640995200&until=1648771200&entityType=country&limit=300',90000);
