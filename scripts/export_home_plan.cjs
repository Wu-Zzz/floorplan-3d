const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const elements = new Map();
const noop = () => {};
const element = (key) => {
  if (!elements.has(key)) elements.set(key, {
    innerHTML:'',textContent:'',style:{},dataset:{},clientWidth:1600,clientHeight:1600,
    classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
    setAttribute:noop,addEventListener:noop,querySelectorAll:()=>[],
    getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,width:1600,height:1600}),
  });
  return elements.get(key);
};
const saved = new Map();
const ctx = vm.createContext({
  window:{dispatchEvent:noop},Event:class {},document:{querySelector:element,querySelectorAll:()=>[],documentElement:element('html'),body:element('body'),addEventListener:noop},
  localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},
  matchMedia:()=>({matches:false,addEventListener:noop}),addEventListener:noop,
  ResizeObserver:class {observe(){}},setTimeout:()=>0,clearTimeout:noop,
  navigator:{standalone:false},confirm:()=>true,devicePixelRatio:1,console,
});
vm.runInContext(fs.readFileSync(root+'/cad-geometry.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/photo-appearance.js','utf8'),ctx);
vm.runInContext(fs.readFileSync(root+'/home-plan.js','utf8'),ctx);
const html = fs.readFileSync(root+'/index.html','utf8');
const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(m=>m[2].includes('const LANG_KEY'))[2];
vm.runInContext(script,ctx);
const evaluate = s => vm.runInContext(s,ctx);
assert.equal(evaluate('PLAN.height'),2.9);
assert.equal(evaluate('PLAN.north'),'up');
assert.equal(evaluate('PLAN.id'),'home-2a-cad-v2');
assert.equal(evaluate('PLAN.cadSourceAudit.symmetricDifferenceMm2'),0);
assert.equal(evaluate('PLAN.cadSourceAudit.walkableFloorConnected'),true);
assert.equal(evaluate('PLAN.geometryAudit.exactCadMatch'),false);
assert.equal(evaluate('PLAN.geometryAudit.bedroomBodiesUnchanged'),true);
assert.equal(evaluate('PLAN.geometryAudit.kitchenWindowSide'),'north');
// A closed facade must also leave the projecting side panes exposed to outdoors.
assert.equal(evaluate(`PLAN.windows.filter(w=>w.name.includes('飘窗西侧')).every(w=>{
  const a=w.glazingLine[0],b=w.glazingLine[1],x=(a[0]+b[0])/2,y=(a[1]+b[1])/2;
  return !PLAN.walls.some((r,i)=>(PLAN.wallHeights?.['w'+i]??PLAN.height)>=.9&&r[0]<x&&r[2]>x-1000&&r[1]<y&&r[3]>y);
})`),true,'The bay side panes must not face a solid wall.');
for (const id of ['nwbed','nbed','sbed','master']) {
  for (const key of ['poly','bodyRect','bodySize']) {
    assert.equal(evaluate(`JSON.stringify(PLAN.rooms.find(r=>r.id==='${id}')['${key}'])`),evaluate(`JSON.stringify(window.CAD_GEOMETRY.rooms.find(r=>r.id==='${id}')['${key}'])`));
  }
}
assert.equal(evaluate("ROOMS.filter(r=>['nwbed','nbed','sbed','master'].includes(r.id)).length"),4);
const before = evaluate('snap()');
evaluate('mutate(()=>state.furniture[0].w=1600)');
assert.equal(evaluate('state.furniture[0].w'),1600);
evaluate('undo()');
assert.equal(evaluate('snap()'),before);
evaluate('redo()');
assert.equal(evaluate('state.furniture[0].w'),1600);
evaluate('undo()');
assert.deepEqual(JSON.parse(evaluate('JSON.stringify(fixState(JSON.parse(snap())))')),JSON.parse(before));
assert.throws(()=>evaluate("fixState({planId:'different-home',furniture:[]})"));
const wallBefore=evaluate('state.demolished.length');
evaluate("toggleWall('w7')");
assert.equal(evaluate('state.demolished.length'),wallBefore);
const output = root+'/outputs';
const stem = '原图形态-CAD尺寸-四卧方案A';
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(output+'/'+stem+'.json',evaluate('JSON.stringify({floorplan:PLAN,...state},null,2)'));
const bounds = evaluate('PLAN.bounds');
const exportSize = Math.max(bounds.w,bounds.h);
const layers = ['#gRooms','#gFurn','#gWalls','#gOpen','#gLabels','#gDims'].map(k=>`<g>${elements.get(k).innerHTML}</g>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="2200" viewBox="${bounds.x} ${bounds.y} ${exportSize} ${exportSize}" font-family="PingFang SC,Microsoft YaHei,sans-serif"><rect x="${bounds.x}" y="${bounds.y}" width="${exportSize}" height="${exportSize}" fill="#f7f4ee"/><defs>${elements.get('#defs').innerHTML}</defs><text x="240" y="-1280" font-size="275" font-weight="600" fill="#2b2824">我的家 · 四卧方案 A</text><text x="240" y="-980" font-size="175" fill="#7d7366">形态按原图 · 尺寸按CAD · 层高2.9m · 上北下南</text>${layers}</svg>`;
fs.writeFileSync(output+'/'+stem+'.svg',svg);
console.log(JSON.stringify({checks:'CAD source audit retained separately, four bedroom dimensions unchanged, owner-confirmed north kitchen window, height/orientation, edit+undo/redo, JSON round-trip, wrong-plan rejection, wall retention passed',modelFloorArea:evaluate('ROOMS.filter(r=>r.counted!==false).reduce((n,r)=>n+area(r.poly),0)'),furniture:evaluate('state.furniture.length'),outputs:output}));
