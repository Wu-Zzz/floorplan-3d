"""Extract the supplied developer DWG's converted DXF into the browser's floor-plan data.

Only the horizontal plan is measured in the drawing. Vertical heights and the swing
of interior doors are illustrative. Walls are selected CLOSED contours in the DXF,
not centreline traces with an assumed common thickness.
"""
from pathlib import Path
from collections import Counter
import json, math, hashlib
import ezdxf
from ezdxf import bbox
from shapely.geometry import LineString, Polygon, box, Point
from shapely.ops import unary_union, polygonize

ROOT = Path(__file__).resolve().parents[1]
CAD = ROOT.parent / 'CAD核对'
DXF = CAD / '转换文件' / '户型.dxf'
DOC = ezdxf.readfile(DXF)
MSP = DOC.modelspace()
BB = bbox.extents(MSP)
OX, TOP = BB.extmin.x, BB.extmax.y

def p2(p): return [round(p[0] - OX, 3), round(TOP - p[1], 3)]
def R(x0,y0,x1,y1): return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
def style(e):
    return {'layer':e.dxf.layer,'color':e.dxf.color,
            'colorExplicit':e.dxf.hasattr('color'),
            'layerColor':DOC.layers.get(e.dxf.layer).dxf.color,
            'lineweight':e.dxf.lineweight}
source_lines=[]; circles=[]; arcs=[]; polylines=[]
for e in MSP:
    t=e.dxftype()
    if t=='LINE': source_lines.append({'handle':e.dxf.handle,**style(e),'start':p2(e.dxf.start),'end':p2(e.dxf.end)})
    elif t=='CIRCLE': circles.append({'handle':e.dxf.handle,**style(e),'center':p2(e.dxf.center),'radius':round(e.dxf.radius,3)})
    elif t=='ARC':
        c=p2(e.dxf.center);r=e.dxf.radius;a=e.dxf.start_angle;b=e.dxf.end_angle
        delta=(b-a)%360
        pt=lambda ang:[round(c[0]+r*math.cos(math.radians(ang)),3),round(c[1]-r*math.sin(math.radians(ang)),3)]
        s,ee=pt(a),pt(b)
        arcs.append({'handle':e.dxf.handle,**style(e),'center':c,'radius':round(r,3),'startAngle':-a,'endAngle':-b,'sweep':0,'largeArc':int(delta>180),'start':s,'end':ee,'path':f'M{s[0]} {s[1]}A{r} {r} 0 {int(delta>180)} 0 {ee[0]} {ee[1]}'})
    elif t=='LWPOLYLINE': polylines.append({'handle':e.dxf.handle,**style(e),'points':[p2(p) for p in e.get_points()], 'closed':bool(e.closed)})
segments=[LineString([l['start'],l['end']]) for l in source_lines]
network=unary_union(segments)
contours=sorted(polygonize(network),key=lambda p:p.area,reverse=True)

# These CLOSED contour anchors classify the original linework. The two large bay
# seat contours and the repeated 3-line glazing contours are deliberately excluded.
# End returns at the left side of each bay are opaque construction contours in the
# plan; their construction type is unknown, as is that of every other wall.
anchors=[
 (10800,9000,'e'),(120,10000,'e'),(120,3000,'e'),
 (3580,9000,'u'),(3580,3000,'u'),(6600,9000,'u'),
 (11480,3500,'e'),(6600,4000,'u'),(450,12700,'u'),(450,400,'u'),
 (100,6000,'e'),(4500,6830,'u'),
 (10000,5580,'u'),(1200,6150,'u'),(2350,5700,'u'),
 (6600,2150,'u'),(9400,2150,'u'),(4000,2150,'u'),
 (10400,11000,'u'),(4000,11100,'u'),(2450,6830,'u'),
 (2340,4350,'u'),(3430,4200,'u'),
]
selected=[]
for x,y,kind in anchors:
    hits=[p for p in contours if p.contains(Point(x,y))]
    assert len(hits)==1,(x,y,len(hits))
    pp=hits[0]
    assert not any(pp.equals(q[0]) for q in selected), (x,y,'duplicate wall contour')
    selected.append((pp,kind))

# Exact rectangle decomposition; internal slice edges are rendering details only.
def rectangles(poly):
    xs=sorted(set(x for x,y in poly.exterior.coords))
    result=[]
    for a,b in zip(xs,xs[1:]):
        if b-a<.001:continue
        cut=poly.intersection(box(a,-1e6,b,1e6))
        for q in getattr(cut,'geoms',[cut]):
            if not isinstance(q,Polygon) or q.area<.001:continue
            x0,y0,x1,y1=q.bounds
            assert abs(q.area-(x1-x0)*(y1-y0))<.01, ('non-rectangular wall slice',q.wkt)
            result.append([x0,y0,x1,y1])
    # Adjacent slices of equal depth may be merged without changing the footprint.
    result.sort(key=lambda r:(r[1],r[3],r[0]))
    merged=[]
    for r in result:
        if merged and abs(merged[-1][2]-r[0])<.001 and merged[-1][1]==r[1] and merged[-1][3]==r[3]: merged[-1][2]=r[2]
        else:merged.append(r)
    return merged
walls=[];wall_polys=[];evidence=[]
for n,(poly,kind) in enumerate(selected):
    rs=rectangles(poly)
    rect_union=unary_union([box(*r) for r in rs])
    assert poly.symmetric_difference(rect_union).area<.01
    # Every outside contour is a CAD line, never a guessed offset centreline.
    assert poly.boundary.difference(network.buffer(.01)).length<.01
    coords=[[round(x,3),round(y,3)] for x,y in list(poly.exterior.coords)[:-1]]
    handles=[l['handle'] for l,s in zip(source_lines,segments) if poly.boundary.intersection(s).length>.01]
    wall_polys.append({'poly':coords,'type':kind,'sourceHandles':handles})
    for rr in rs:
        walls.append([*[round(v,3) for v in rr],kind]); evidence.append({'contour':n,'sourceHandles':handles})

# CAD frame envelopes; sill/head values below are presentation assumptions only.
# The owner confirms a removable glass slider at the north-centre opening.
# CAD opening edges are exact; vertical details and leaf configurations are not provided.
window_defs=[
 ('北卧飘窗正面',[700,0,3570,100],.45,2.4,False,False),
 ('北卧飘窗东侧',[3470,100,3570,550],.45,2.4,False,False),
 ('主卧飘窗正面',[710,13065,3570,13165],.45,2.4,False,False),
 ('主卧飘窗东侧',[3470,12605,3570,13065],.45,2.4,False,False),
 ('次卫窗',[0,4655,195,5405],1.2,2.4,False,False),
 ('主卫窗',[0,6945,195,7695],1.2,2.4,False,False),
 ('南中卧窗',[4220,11080,6470,11205],.9,2.4,False,False),
 ('厨房北窗',[9735,2030,10875,2300],.9,2.4,False,False),
 ('北阳台北沿',[3895,550,9735,750],.1,1.1,True,False),
 ('北阳台东沿',[9525,750,9735,2030],.1,1.1,True,False),
 ('南阳台西沿',[6470,11205,6710,13225],.1,1.1,True,False),
 ('南阳台南沿',[6710,12985,10680,13225],.1,1.1,True,False),
]
corner_glazing={
    '北卧飘窗正面':([[700,50],[3520,50]],[True,True],'north-bay'),
    '北卧飘窗东侧':([[3520,50],[3520,550]],[False,True],'north-bay'),
    '主卧飘窗正面':([[710,13115],[3520,13115]],[True,True],'master-bay'),
    '主卧飘窗东侧':([[3520,12605],[3520,13115]],[True,False],'master-bay'),
}
windows=[]
for name,rr,sill,head,open_above,inferred in window_defs:
    region=box(*rr)
    frame_lines=[]
    for l in source_lines:
        inter=LineString([l['start'],l['end']]).intersection(region)
        if inter.length>.02:
            for g in getattr(inter,'geoms',[inter]):
                if isinstance(g,LineString) and g.length>.02:
                    a,b=list(g.coords)[0],list(g.coords)[-1]
                    # Keep exact source endpoints where clipping was unnecessary.
                    a=[round(v,3) for v in a];b=[round(v,3) for v in b]
                    frame_lines.append({'start':a,'end':b,'handle':l['handle'],'color':l['color'],'colorExplicit':l['colorExplicit']})
    # Corner glass is now owner-confirmed. The CAD still supplies the plan outline;
    # the glazing centrelines below share a joint, rather than leaving a 50mm gap.
    confirmed_corner=name in {'北卧飘窗正面','北卧飘窗东侧','主卧飘窗正面','主卧飘窗东侧'}
    uncertain_edge=open_above
    kind='corner-window' if confirmed_corner else 'unconfirmed-balcony-edge' if uncertain_edge else 'window'
    display='unconfirmed-outline' if uncertain_edge else 'simple-window'
    evidence_note=(
        '转角玻璃由业主确认，平面轮廓按CAD；窗高、窗台及窗扇分格仍待确认。' if confirmed_corner else
        'CAD仅有外围多平行线，不能确认护栏材质、封窗形式或高度。' if uncertain_edge else
        '平面框线取自CAD；窗高、窗台高与立面分格尚未确认。'
    )
    item={'name':name,'rect':rr,'sill':sill,'head':head,'openAbove':open_above,
                    'verticalAssumed':True,'classificationFromPhoto':inferred,'frameLines':frame_lines,
                    'kind':kind,'display3d':display,'evidenceNote':evidence_note,
                    'frameDivisionConfirmed':False}
    if confirmed_corner:
        line,posts,group=corner_glazing[name]
        item.update(glazingLine=line,endPosts=posts,cornerGroup=group,classificationSource='owner-confirmed',material='glass')
    windows.append(item)

# This thin exterior outline shares the CAD's cyan glazing/parapet colour. Its
# construction and height cannot be inferred from a closed outline alone. Keep
# source geometry traceable without converting it into an opaque wall or floor.
exterior_features=[{'id':'southMiddleEdge','name':'南中卧外侧窄沿（构造待核）',
 'poly':R(3700,11205,6470,11305),'sourceHandles':['F2','102','106'],
 'source':'CAD','kind':'unclassified-outline','noWall':True,'noExtraFloor':True}]

def door(name,rr,h,c,o,L,entry=False):
    return {'name':name,'rect':rr,'h':h,'c':c,'o':o,'len':L,'entry':entry,'swingAssumed':not entry,'heightAssumed':True}
doors=[
 door('西北卧室门',[2505,4155,3395,4305],[3395,4155],[-1,0],[0,-1],890),
 door('北中卧室门',[3800,5570,4710,5700],[3800,5570],[1,0],[0,-1],910),
 door('南中卧室门',[5470,6765,6370,6905],[6370,6905],[-1,0],[0,1],900),
 door('主卧套间门',[2510,6765,3420,6905],[3420,6905],[-1,0],[0,1],910),
 door('次卫门',[2275,4395,2405,5195],[2275,4395],[0,1],[-1,0],800),
 door('主卫门',[2275,7165,2405,7995],[2275,7995],[0,-1],[-1,0],830),
 door('入户门',[10680,5800,10980,6870],[10980,5800],[0,1],[1,0],1070,True),
]
slides=[
 {'name':'北中卧—生活阳台推拉玻璃门','rect':[4220,2030,6220,2300],'v':False,'head':2.4,'material':'glass','removable':True,'classificationSource':'owner-confirmed','removabilitySource':'owner-confirmed','leafAssumed':True,'heightAssumed':True},
 {'name':'生活阳台洞口','rect':[7140,2030,9135,2300],'v':False,'head':2.4,'leafAssumed':True,'heightAssumed':True},
 {'name':'南阳台洞口','rect':[7220,10925,10180,11205],'v':False,'head':2.4,'leafAssumed':True,'heightAssumed':True},
]
def room(rid,name,poly,mat,at,body=None,**kw):
    out={'id':rid,'name':name,'poly':poly,'mat':mat,'at':at,**kw}
    if body:out.update(bodyRect=body,bodySize=[body[2]-body[0],body[3]-body[1]])
    return out
rooms=[
 room('nwbed','西北卧室',R(240,830,3470,4155),'wood',[2700,2300],[240,830,3470,4155]),
 room('nbed','北中卧室',R(3700,2300,6470,5570),'wood',[4100,2750],[3700,2300,6470,5570],bodyNote='北边以两端墙垛内沿为控制线；2000mm推拉玻璃门洞另计，门体可拆卸由业主确认'),
 room('sbed','南中卧室',[[3700,6905],[6470,6905],[6470,11080],[4220,11080],[4220,10980],[3700,10980]],'wood',[5900,9000],[3700,6905,6470,10980],bodyNote='窗边局部向南另有100mm，不含室外凹口'),
 room('master','主卧室',[[2405,6905],[3470,6905],[3470,12335],[240,12335],[240,8215],[2405,8215]],'wood',[2800,10200],[240,8215,3470,12335],bodyNote='主体净距；套间过道、飘窗另计'),
 room('gbath','次卫',R(195,4305,2275,6085),'antislip',[1250,5500],[195,4305,2275,6085]),
 room('mbath','主卫',R(195,6215,2275,8095),'antislip',[1250,7450],[195,6215,2275,8095]),
 room('hall','过道',[[2405,4305],[3470,4305],[3470,5700],[6710,5700],[6710,6765],[2405,6765]],'tile800',[4600,6150],[2405,4305,3470,6765],bodyNote='1065为西侧纵向过道净宽；横向过道另计'),
 room('dining','餐厅',R(6710,2300,9485,5700),'tile800',[7900,2600],functional=True,bodyNote='与厨房、玄关连续开放，功能分区线不表示墙体'),
 room('kitchen','厨房',[[9485,2300],[11385,2300],[11385,5100],[10865,5100],[10865,5460],[9485,5460]],'tile600',[10400,3900],functional=True,bodyNote='西侧无隔墙；功能分界并非已砌墙面，右下管井符号区留空'),
 room('living','客厅 / 玄关',R(6710,5700,10680,10925),'tile800',[8600,6400],[6710,6870,10680,10925],bodyNote='主体净宽3970；北侧玄关另计，功能区间没有新增隔墙'),
 room('laundry','北生活阳台',[[3700,965],[3895,965],[3895,750],[9525,750],[9525,2030],[3700,2030]],'antislip',[8000,1480],[3895,750,9525,2030],bodyNote='设备占位依照片保留，不生成CAD未画出的设备隔墙'),
 room('balcony','南阳台',R(6710,11205,10680,12985),'tile600',[8750,12200],[6710,11205,10680,12985]),
 room('bayNorth','北卧飘窗',R(700,100,3470,830),'marble',None,[700,100,3470,830],counted=False,kind='bay',elevation=.45,heightAssumed=True),
 room('baySouth','主卧飘窗',R(710,12335,3470,13065),'marble',None,[710,12335,3470,13065],counted=False,kind='bay',elevation=.45,heightAssumed=True),
]
reserved=[
 {'id':'acNorth','name':'北侧外机预留（位置依照片）','poly':R(3895,750,6470,1300),'source':'photo-inferred','kind':'equipment','noWall':True,'noExtraFloor':True},
 {'id':'acSouth','name':'南侧外机预留（位置依照片）','poly':R(6710,11205,7150,12985),'source':'photo-inferred','kind':'equipment','noWall':True,'noExtraFloor':True},
 {'id':'shaft','name':'管井符号区（用途待核）','poly':R(10865,5100,11385,5460),'source':'CAD','kind':'shaft','noExtraFloor':True},
]
# Long external dimensions report inner-face distances, not a fake overall
# handwritten chain. offsets follow the left normal in the plan's southward y.
dims=[
 {'a':[240,830],'b':[3470,830],'offset':-1500,'label':'3230','source':'CAD'},
 {'a':[3700,2300],'b':[6470,2300],'offset':-2970,'label':'2770','source':'CAD'},
 {'a':[240,830],'b':[240,4155],'offset':650,'label':'3325','source':'CAD'},
 {'a':[195,4305],'b':[195,6085],'offset':605,'label':'1780','source':'CAD'},
 {'a':[195,6215],'b':[195,8095],'offset':605,'label':'1880','source':'CAD'},
 {'a':[240,8215],'b':[240,12335],'offset':650,'label':'4120','source':'CAD'},
 {'a':[240,12335],'b':[3470,12335],'offset':1580,'label':'3230','source':'CAD'},
 {'a':[3700,10980],'b':[6470,10980],'offset':2935,'label':'2770','source':'CAD'},
 {'a':[6710,12985],'b':[10680,12985],'offset':930,'label':'3970','source':'CAD'},
 {'a':[6470,2300],'b':[6470,5570],'offset':-6350,'label':'3270','source':'CAD'},
 {'a':[6470,6905],'b':[6470,10980],'offset':-6350,'label':'4075','source':'CAD'},
 {'a':[10680,11205],'b':[10680,12985],'offset':-2140,'label':'1780','source':'CAD'},
 {'a':[195,6085],'b':[2275,6085],'offset':-450,'label':'2080','source':'CAD'},
 {'a':[195,8095],'b':[2275,8095],'offset':-450,'label':'2080','source':'CAD'},
]
# Structural and coverage checks from source-contour-derived wall polygons.
WU=unary_union([p for p,k in selected]);WR=unary_union([box(*w[:4]) for w in walls])
assert WU.symmetric_difference(WR).area<.01
cyan=unary_union([s for l,s in zip(source_lines,segments) if l['color']==4])
cyan_wall_boundary=sum(p.boundary.intersection(cyan).length for p,k in selected)
assert cyan_wall_boundary<.01,'a cyan glazing/parapet contour was classified as opaque wall'
assert not any(box(*w[:4]).contains(Point(9600,4000)) for w in walls), 'invented kitchen partition'
for r in rooms:
    pp=Polygon(r['poly']);assert pp.is_valid and pp.area>0,r['id']
    assert pp.intersection(WU).area<.05,(r['id'],pp.intersection(WU).area)
for i,a in enumerate(rooms):
    for b in rooms[i+1:]: assert Polygon(a['poly']).intersection(Polygon(b['poly'])).area<.01,(a['id'],b['id'])
assert not any(Polygon(r['poly']).contains(Point(5000,12100)) for r in rooms),'exterior notch filled'
# Every walkable room joins the rest of the home through its exact CAD opening.
# This verifies the threshold patches as well as the main room polygons.
thresholds=[box(*d['rect']) for d in doors+slides]
floor_union=unary_union([Polygon(r['poly']) for r in rooms if r.get('counted') is not False]+thresholds)
assert isinstance(floor_union,Polygon), 'disconnected room or threshold floor'
assert sum(p.intersection(WU).area for p in thresholds)<.01,'threshold crosses a CAD wall'
assert not floor_union.contains(Point(5000,12100)), 'threshold patches filled exterior notch'
threshold_adjacency={}
for d in doors+slides:
    p=box(*d['rect'])
    joins=[r['id'] for r in rooms if p.boundary.intersection(Polygon(r['poly']).boundary).length>1]
    assert len(joins)==(1 if d.get('entry') else 2),(d['name'],joins)
    threshold_adjacency[d['name']]=joins
assert len(source_lines)==159 and len(circles)==11 and len(arcs)==1 and len(polylines)==1
assert [(r['id'],r['bodySize']) for r in rooms[:6]]==[
 ('nwbed',[3230,3325]),('nbed',[2770,3270]),('sbed',[2770,4075]),('master',[3230,4120]),('gbath',[2080,1780]),('mbath',[2080,1880])]
result={
 'id':'home-2a-cad-v2','units':'mm','source':{'filename':'2栋1户型(1).dwg','version':DOC.dxfversion,'sha256':hashlib.sha256((CAD/'原始文件'/'2栋1户型.dwg').read_bytes()).hexdigest(),'coordinateOrigin':[OX,TOP],'coordinates':'x east, y south; source uppermost point y=0'},
 'walls':walls,'wallPolygons':wall_polys,'wallEvidence':evidence,
 'windows':windows,'doors':doors,'slides':slides,'rooms':rooms,'reservedZones':reserved,'exteriorFeatures':exterior_features,'lintels':[],
 'bounds':{'x':-1350,'y':-1600,'w':15700,'h':16200},'center':[5790,6610],
 'dimensions':[],'dimensionSegments':dims,'sourceLines':source_lines,'sourceCircles':circles,'sourceArcs':arcs,'sourcePolylines':polylines,
 'entryMarker':{'from':[13350,6335],'to':[11200,6335]},'walkStart':[10150,6335],'walkLook':[7900,6335],
 'annotations':[{'at':[5220,2200],'text':'推拉玻璃门·可拆卸'},{'at':[5000,12100],'text':'室外凹口'},{'at':[5000,12400],'text':'不补地板 · 外机布置待核'}],
 'assumptions':[
  '平面墙线、墙厚、洞口边缘、已有窗框与主体净距来自开发商CAD；厨房餐厅之间无隔墙由业主确认。',
  '层高2.9m与图上方朝北由业主明确提供；门高、窗台高、栏板高、飘窗台高均为3D展示假定，不是CAD标高。',
  '北中卧与生活阳台间为可拆卸推拉玻璃门，由业主确认；2000mm洞宽按CAD，门高及门扇数量仍为展示设定。室内平开门开向和其他阳台门型依照片示意，CAD未给出完整门窗表。',
  '北、南阳台的外机占位依照片提示，未新增设备隔墙；南中卧外不生成CAD未画出的深设备平台。',
  '主卧与西北卧的转角玻璃已由业主确认，按CAD折返轮廓展示；阳台外沿仍仅以待核线框展示，未认定为玻璃护栏。',
  '窗框平面线按原CAD绘制；3D已取消自动补出的约0.9m竖梃，窗型、分格、窗台高、窗顶高均不能由本平面图确定。',
  '飘窗左端封闭构造轮廓照CAD保留，结构性质与高度待现场核对；所有墙体均未判定为承重或可拆。',
  '厨房右下管井符号区保留空位，用途及管线需核实；功能区边界仅用于铺地统计，不代表新增隔墙。',
  '厨房北窗按CAD青色实体107/108及两侧墙垛识别，净洞1140mm；东墙未画窗洞。南中卧外100mm窄沿也属青色构造线，不作实墙或地面扩展。',
 ],
 'geometryAudit':{'modelEntityCounts':dict(Counter(e.dxftype() for e in MSP)),'wallContourCount':len(selected),'wallRectangleCount':len(walls),'wallContourAreaMm2':round(WU.area,3),'rectUnionAreaMm2':round(WR.area,3),'symmetricDifferenceMm2':round(WU.symmetric_difference(WR).area,6),'opaqueWallBoundaryOnWindowColorMm':round(cyan_wall_boundary,6),'roomWallOverlapMm2':0,'roomOverlapMm2':0,'thresholdWallOverlapMm2':0,'walkableFloorConnected':True,'thresholdAdjacency':threshold_adjacency,'exteriorNotchUnfilled':True,'sourceLines':len(source_lines),'cadUnits':DOC.units},
}
(ROOT/'cad-geometry.js').write_text('/* Generated by scripts/build_cad_geometry.py from the supplied developer CAD. */\nwindow.CAD_GEOMETRY = '+json.dumps(result,ensure_ascii=False,separators=(',',':'))+';\n')
(ROOT/'scripts'/'cad-geometry-audit.json').write_text(json.dumps(result['geometryAudit'],ensure_ascii=False,indent=2))
print(json.dumps(result['geometryAudit'],ensure_ascii=False,indent=2))
