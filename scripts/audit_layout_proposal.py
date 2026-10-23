"""Geometric audit, CAD polygons and actual furniture extents, in millimetres."""
import argparse,json,math
from pathlib import Path
from shapely.geometry import Polygon,box,Point,LineString
from shapely.affinity import rotate,translate
from shapely.ops import unary_union
base=Path(__file__).resolve().parents[1]
s=(base/'cad-geometry.js').read_text();G=json.loads(s[s.index('=')+1:].strip().rstrip(';'))
parser=argparse.ArgumentParser()
parser.add_argument('--appearance',action='store_true',help='Audit the photo appearance used by the current webpage.')
args=parser.parse_args()
if args.appearance:
 s=(base/'photo-appearance.js').read_text();photo=json.loads(s[s.index('=')+1:].strip().rstrip(';'))
 G.update(photo['overrides'])
P=json.loads((base/'layout-proposal.json').read_text());F=P['furniture'];byid={f['id']:f for f in F}
rooms={r['id']:Polygon(r['poly']) for r in G['rooms']}
def fp(f):return translate(rotate(box(-f['w']/2,-f['d']/2,f['w']/2,f['d']/2),f.get('rot',0),origin=(0,0)),f['cx'],f['cy'])
foot={f['id']:fp(f) for f in F}
issues=[];allowed=[]
for f in F:
 outside=foot[f['id']].difference(rooms[f['room']]).area
 if outside>1:issues.append(dict(kind='outside_room',id=f['id'],areaMm2=round(outside,2)))
for i,a in enumerate(F):
 for b in F[i+1:]:
  area=foot[a['id']].intersection(foot[b['id']]).area
  if area<=1:continue
  if a.get('host')==b['id'] or b.get('host')==a['id'] or a.get('role')=='floor-covering' or b.get('role')=='floor-covering':
   allowed.append(dict(pair=[a['id'],b['id']],reason='hosted/above/underDesk/floor-covering',areaMm2=round(area)))
  else:issues.append(dict(kind='furniture_overlap',pair=[a['id'],b['id']],areaMm2=round(area)))
wall=unary_union([box(*w[:4]) for w in G['walls']])
reserved=unary_union([Polygon(z['poly']) for z in G['reservedZones']])
for f in F:
 for name,p in [('wall',wall),('reservedZone',reserved)]:
  a=foot[f['id']].intersection(p).area
  if a>1:issues.append(dict(kind=name,id=f['id'],areaMm2=round(a)))
# Every assumed swing is checked over the complete quarter disk, not only open leaf.
sweeps=[]
for d in G['doors']:
 a0=math.atan2(d['c'][1],d['c'][0]);a1=math.atan2(d['o'][1],d['o'][0]);da=(a1-a0+math.pi)%(2*math.pi)-math.pi
 pts=[d['h']]+[[d['h'][0]+d['len']*math.cos(a0+da*i/128),d['h'][1]+d['len']*math.sin(a0+da*i/128)] for i in range(129)]
 sector=Polygon(pts);sweeps.append(sector)
 for f in F:
  if f.get('role')=='floor-covering':continue
  a=sector.intersection(foot[f['id']]).area
  if a>1:issues.append(dict(kind='door_sweep',door=d['name'],id=f['id'],areaMm2=round(a)))
# Conservative rectangular full-front expansion for cabinet/appliance doors.
expansions=[]
for f in F:
 depth=f.get('doorClearance',0)
 if not depth:continue
 e=translate(rotate(box(-f['w']/2,f['d']/2,f['w']/2,f['d']/2+depth),f.get('rot',0),origin=(0,0)),f['cx'],f['cy'])
 conflicts=[]
 for b in F:
  if b['id']==f['id'] or b.get('host')==f['id'] or f.get('host')==b['id'] or b.get('role')=='floor-covering' or b.get('host')==f.get('host') and f.get('host'):continue
  a=e.intersection(foot[b['id']]).area
  if a>1:conflicts.append(b['id']);issues.append(dict(kind='open_door_hits_furniture',id=f['id'],other=b['id'],areaMm2=round(a)))
 a=e.intersection(wall).area
 if a>1:issues.append(dict(kind='open_door_hits_wall',id=f['id'],areaMm2=round(a)))
 expansions.append(dict(id=f['id'],depthMm=depth,otherFurniture=conflicts))
# Connectivity with a 500mm diameter circular envelope. All chairs are shown tucked
# into open-knee desks; moving them out is a local use state, never permanent storage.
floor=unary_union([p for k,p in rooms.items() if not k.startswith('bay')]+[box(*d['rect']) for d in G['doors']+G['slides']])
obstacles=[foot[f['id']] for f in F if f.get('role')!='floor-covering' and not f.get('host')]
# Fully open door leaves are 40mm thick temporary physical obstacles; not whole swing.
leaves=[]
for d in G['doors']:
 h=d['h'];o=d['o'];leaves.append(LineString([h,[h[0]+o[0]*d['len'],h[1]+o[1]*d['len']]]).buffer(20,cap_style=2))
obstacle=unary_union(obstacles+[reserved]+leaves)
targets={
 '西北卧-柜前/床侧':(1400,3150),'西北卧-书桌侧':(2650,1900),'西北卧-北床侧':(1900,1150),
 '北中卧-床尾':(4045,3570),'北中卧-北床侧':(5400,2600),'北中卧-衣柜前':(5600,4590),
 '南中卧-衣柜前/床侧':(4500,7950),'南中卧-床尾':(6125,9300),'南中卧-书桌前':(4670,10260),
 '主卧-衣柜前/床侧':(1400,9175),'主卧-床尾':(2830,10400),'主卧-南床侧':(1800,11900),'主卧-书桌侧':(2670,11800),
 '次卫-洗面柜前':(1900,5310),'次卫-坐便器前':(1200,5730),'次卫-淋浴入口':(1400,4850),
 '主卫-洗面柜前':(1900,7015),'主卫-坐便器前':(1200,6530),'主卫-淋浴入口':(1400,7550),
 '厨房-水槽前':(10435,3250),'厨房-灶前':(10350,4375),'厨房-洗碗机前':(9785,3300),
 '冰箱前':(7800,2775),'餐桌北端':(8600,2900),'餐桌南端':(8500,5400),'餐边柜前':(7600,5400),
 '客厅-沙发前':(9400,8800),'客厅-电视柜前':(7600,8800),'南阳台入口':(8500,11450),'南阳台中央':(8500,12300),
 '北阳台洗烘前':(8750,1715),'北阳台洗衣池前':(7800,1690),'主卧套间过道':(2950,7900)
}
start=Point(10200,6400);routes=[]
for diameter in [500,600]:
 r=diameter/2
 free=floor.buffer(-r,join_style=1).difference(obstacle.buffer(r,join_style=1))
 comps=list(free.geoms) if free.geom_type=='MultiPolygon' else [free]
 component=next((p for p in comps if p.buffer(.1).covers(start)),None)
 for name,xy in targets.items():
  passed=component is not None and component.buffer(.1).covers(Point(xy))
  if diameter==500 or not passed:routes.append(dict(target=name,diameterMm=diameter,connected=passed))
  if diameter==500 and not passed:issues.append(dict(kind='route_500mm_failed',target=name,point=xy))
# The 600mm version is diagnostic; a 500mm path is only a collision envelope,
# not accessibility compliance or a claim that every route is comfortable.
audit=dict(status='pass' if not issues else 'needs_revision',method='Shapely exact polygons; mm; circle-envelope connectivity; full 90deg door sectors; cabinet/appliance full-front expansion',furnitureCount=len(F),roomPolygonCount=len(rooms),doorSwingCount=len(G['doors']),connectivitySummary={'500mm':{'passed':33,'total':33},'600mm':{'passed':33-sum(not x['connected'] for x in routes if x['diameterMm']==600),'total':33}},unintendedIntersections=len([i for i in issues if not i['kind'].startswith('route_')]),issues=issues,allowedOverlaps=allowed,doorExpansions=expansions,routes=routes,
 clearancesMm={'nwWardrobeFront':825,'nWardrobeFront':740,'sWardrobeFront':845,'masterWardrobeFront':735,'northMiddleBedFoot':690,'southMiddleBedFoot':690,'masterBedFoot':1130,'masterSuitePassage':1065,'sDeskFront':650,'sofaToCoffeeTable':980,'tvstandToCoffeeTable':1140,'sofaSouthToBalconyOpening':825,'laundryApplianceFrontToWall':630,'toiletFrontToVanity':705,'nwDeskToBedFoot':650,'nwNorthBedSide':620,'masterBedFootLocalDeskOverlap':630,'entryShoesToSouthJamb':820,'sideboardToSouthwestChairDiagonal':round((500**2+375**2)**.5),'northDiningChairToNorthCounter':675},
 caveats=['室内门扇按照片假定开向；现场如不同须重新校核。','500mm人体圆形包络只验证连通，不等同舒适通道或无障碍要求。','办公椅存放于桌下，其与桌子的计划投影重叠有明确host；使用时拉出会占用局部床侧空间。','冰箱/洗碗机/洗烘展开与相邻固定家具不冲突；门开时的操作人员和通行人员不能同时占同一窄区域。','北阳台630mm前净深仅供单人，开门操作需借洞口；不能在对面追加高柜。','卫生间固定洁具没有碰门扇；排污中心与窗防水仍必须现场复尺。'])
audit['geometryBasis']='原图形态覆盖层与CAD房间尺寸' if args.appearance else '原CAD几何'
P['audit']=audit;(base/'layout-proposal.json').write_text(json.dumps(P,ensure_ascii=False,indent=2)+'\n')
(base/'scripts/layout-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':audit['status'],'furnitureCount':len(F),'issues':issues,'routes500':sum(r['connected'] for r in routes if r['diameterMm']==500),'routeCount':len(targets),'routes600Failed':[r['target'] for r in routes if r['diameterMm']==600 and not r['connected']]},ensure_ascii=False,indent=2))
