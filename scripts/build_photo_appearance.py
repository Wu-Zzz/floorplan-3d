"""Build the owner's photo appearance as an explicit overlay on measured CAD.

The source CAD and its audit are never edited.  This layer records where a photo
or owner confirmation changes a construction interpretation, not its provenance.
"""
from pathlib import Path
import argparse, copy, json, os
from shapely.geometry import Polygon, box, LineString, Point
from shapely.ops import unary_union

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--kitchen-window-side',choices=['east','north'],
                    default=os.environ.get('KITCHEN_WINDOW_SIDE','north'))
args=parser.parse_args()
raw=(ROOT/'cad-geometry.js').read_text()
cad=json.loads(raw[raw.index('=')+1:].strip().rstrip(';'))

def R(x0,y0,x1,y1):return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
def line(a,b):return {'start':a,'end':b,'source':'owner-photo-appearance'}
def rectangle_parts(poly):
    """Axis aligned decomposition after cutting photograph-confirmed openings."""
    out=[]
    if poly.is_empty:return out
    for p in getattr(poly,'geoms',[poly]):
        if not isinstance(p,Polygon) or p.area<.1:continue
        xs=sorted({x for x,y in p.exterior.coords})
        for a,b in zip(xs,xs[1:]):
            for q in getattr(cut:=p.intersection(box(a,-1e6,b,1e6)),'geoms',[cut]):
                if isinstance(q,Polygon) and q.area>.1:
                    rr=q.bounds
                    assert abs(q.area-box(*rr).area)<.01
                    out.append([round(v,3) for v in rr])
    return out

# Remove the two left bay infill interpretations.  The measured bedroom interior
# faces and the original bay front/back control lines remain unchanged.
cuts=[box(240,0,700,830),box(240,12335,710,13165),
      box(0,0,240,550),box(0,12605,240,13165),
      # The owner's south balcony has a thin east return, not a full-height wall.
      box(10680,11205,10980,13225)]
if args.kitchen_window_side=='east':cuts.append(box(11385,3000,11585,4850))
CUT=unary_union(cuts)
walls=[];wall_origins=[];heights={}
for i,w in enumerate(cad['walls']):
    for rr in rectangle_parts(box(*w[:4]).difference(CUT)):
        walls.append([*rr,w[4]]);wall_origins.append({'source':'CAD','cadWall':i})

def wall(rr,h,description):
    k=len(walls);walls.append([*rr,'u'])
    if h is not None:heights['w'+str(k)]=h
    wall_origins.append({'source':'owner-photo-appearance','note':description,'heightAssumed':True,
                         'enclosureToRoomHeight':h is None})

# Only the rear connection to the bedroom is opaque/full-height.  The area west
# of the projected glass is OUTDOORS, with neither a large wall nor a low slab.
# The U-shaped window itself supplies its continuous narrow sill/base below.
wall([240,550,700,830],None,'北飘窗后端接墙封带；只在左玻璃终点后方')
wall([240,12335,710,12605],None,'主卧飘窗后端接墙封带；只在左玻璃终点后方')
# Equipment slots visible in the owner's original photo, never copied from the
# other unit's very different balconies.  These separators are low edge pieces.
wall([3895,1230,6470,1300],.25,'北侧两台外机低边沿；照片比例')
wall([7150,11205,7220,12985],.25,'南阳台西侧外机条带低边沿；照片形态并锚定CAD门垛')
wall([3700,11755,6470,11825],.15,'南中卧外浅设备平台外沿；照片比例')
if args.kitchen_window_side=='east':
    walls.append([9735,2030,10875,2300,'e'])
    wall_origins.append({'source':'appearance-option','note':'选择东窗时按原照片外观封北侧窗位；非默认'})

windows=[]
def window(name,rr,path,*,sill=.45,head=2.4,posts=(True,True),group=None,
           lines=None,kind='u-bay',display='simple-window',estimated=False,source='owner-photo'):
    return {'name':name,'rect':rr,'sill':sill,'head':head,'openAbove':display!='simple-window',
            'glazingLine':path,'endPosts':list(posts),'cornerGroup':group,
            'display3d':display,'kind':kind,'material':'glass' if display=='simple-window' else 'railing',
            'classificationSource':source,'verticalAssumed':True,'proportionsAssumed':estimated,
            'frameDivisionConfirmed':False,'appearanceLines':lines or [],
            'evidenceNote':'外观依业主原始户型照片；沿用本户CAD控制坐标，新增端部及高程为示意。'}

for south in [False,True]:
    prefix='主卧' if south else '北卧';group='master-bay-photo' if south else 'north-bay-photo'
    yfront=13165 if south else 0
    # Keep the original CAD depth and principal front span.  Only a 100 mm corner
    # join is added to the left.  Its outer side is clear outdoor space.
    xf0,xf1=(610 if south else 600),3570;xs=[0,30,70,100]
    front=[];left=[];right=[]
    for off in xs:
        y=yfront-off if south else yfront+off
        front.append(line([xf0+off,y],[xf1-off,y]))
        lo=12605 if south else y;hi=y if south else 550
        left.append(line([xf0+off,lo],[xf0+off,hi]))
        right.append(line([xf1-off,lo],[xf1-off,hi]))
    if south:
        rrfront=[610,13065,3570,13165];rrleft=[610,12605,710,13065];rrright=[3470,12605,3570,13065]
        pl=[[660,12605],[660,13115]];pf=[[660,13115],[3520,13115]];pr=[[3520,12605],[3520,13115]]
        postsl=(True,False);postsr=(True,False)
    else:
        rrfront=[600,0,3570,100];rrleft=[600,100,700,550];rrright=[3470,100,3570,550]
        pl=[[650,50],[650,550]];pf=[[650,50],[3520,50]];pr=[[3520,50],[3520,550]]
        postsl=(False,True);postsr=(False,True)
    windows += [window(prefix+'飘窗正面',rrfront,pf,group=group,lines=front,estimated=True),
                window(prefix+'飘窗西侧短返',rrleft,pl,posts=postsl,group=group,lines=left,estimated=True),
                window(prefix+'飘窗东侧短返',rrright,pr,posts=postsr,group=group,lines=right)]

for w in cad['windows']:
    if w['name'] in ['次卫窗','主卫窗','南中卧窗']:
        q=copy.deepcopy(w);q['display3d']='simple-window';windows.append(q)
    if w['name']=='厨房北窗' and args.kitchen_window_side=='north':
        q=copy.deepcopy(w);q.update(display3d='simple-window',classificationSource='owner-confirmed-CAD',
            evidenceNote='业主确认厨房在北墙开窗；位置按本户CAD，窗台与窗顶高度仍为示意。')
        windows.append(q)
if args.kitchen_window_side=='east':
    rr=[11385,3000,11585,4850]
    windows.append(window('厨房东窗（照片比例选项）',rr,[[11485,3000],[11485,4850]],sill=.9,kind='flat-window',
                          estimated=True,lines=[line([x,3000],[x,4850]) for x in [11385,11445,11525,11585]]))

# The owner's balconies have perimeter outlines in plan.  The rendering is a
# restrained railing representation; it does not assert full-height enclosure.
balconies=[
 ('北阳台北沿',[3895,550,9735,750],[[3895,650],[9630,650]],(True,True),'north-balcony-photo'),
 ('北阳台东沿',[9525,750,9735,2030],[[9630,650],[9630,2030]],(False,True),'north-balcony-photo'),
 ('南阳台西沿',[6470,11205,6710,13225],[[6590,11205],[6590,13105]],(True,True),'south-balcony-photo'),
 ('南阳台南沿',[6710,12985,10980,13225],[[6590,13105],[10830,13105]],(False,True),'south-balcony-photo'),
 ('南阳台东沿',[10680,11205,10980,12985],[[10830,11205],[10830,13105]],(True,False),'south-balcony-photo'),
]
for name,rr,path,posts,group in balconies:
    existing=next((w for w in cad['windows'] if w['name']==name),None)
    ls=copy.deepcopy(existing.get('frameLines',[])) if existing else []
    if name in ['南阳台南沿','南阳台东沿']:
        ls=[line(path[0],path[1])]
    windows.append(window(name,rr,path,sill=.1,head=1.1,posts=posts,group=group,
                          kind='balcony-edge',display='simple-railing',lines=ls,estimated='东沿' in name))

rooms=copy.deepcopy(cad['rooms']);byid={r['id']:r for r in rooms}
byid['bayNorth'].update(appearanceSource='owner-photo',counted=False)
byid['baySouth'].update(appearanceSource='owner-photo',counted=False)
byid['laundry']['poly']=[[3700,965],[3895,965],[3895,1300],[6470,1300],[6470,750],[9525,750],[9525,2030],[3700,2030]]
byid['laundry']['bodyNote']='总包络沿本户CAD；西侧外机槽按原照片拆分，不计入室内可用面积。'
byid['balcony'].update(poly=R(7220,11205,10680,12985),bodyRect=[7220,11205,10680,12985],bodySize=[3460,1780],
                      bodyNote='东侧活动区；原CAD3970总净宽中西侧510按照片留作外机条带，分界锚定CAD滑门左垛，需复尺。')
for rid,name,rr in [('acNorth','北侧设备槽',[3895,750,6470,1230]),
                    ('acMiddle','南中卧外浅设备平台',[3700,11205,6470,11755]),
                    ('acSouth','南阳台西侧设备条带',[6710,11205,7150,12985])]:
    rooms.append({'id':rid,'name':name,'poly':R(*rr),'mat':'tile600','kind':'service','counted':False,
                  'appearanceSource':'owner-photo','proportionsAssumed':True})
reserved=[r for r in copy.deepcopy(cad['reservedZones']) if r['id']=='shaft']
for r in rooms:
    if r.get('kind')=='service':reserved.append({'id':r['id'],'name':r['name'],'poly':r['poly'],
        'source':'owner-photo','kind':'equipment','noWall':True,'noExtraFloor':False,'proportionsAssumed':True})

# Verify precisely what this overlay promises, without relabelling it exact CAD.
for rid in ['nwbed','nbed','sbed','master']:
    a=byid[rid];b=next(r for r in cad['rooms'] if r['id']==rid)
    assert a['poly']==b['poly'] and a['bodyRect']==b['bodyRect'] and a['bodySize']==b['bodySize']
WU=unary_union([box(*w[:4]) for w in walls])
floor_overlaps=[]
for r in rooms:
    pp=Polygon(r['poly']);assert pp.is_valid and pp.area>0,r['id']
    # Raised bay tops may cover a sill footprint; normal walkable rooms may not.
    if r.get('kind') not in ['bay','service']:
        a=pp.intersection(WU).area
        assert a<.01,(r['id'],a)
for i,a in enumerate(rooms):
    for b in rooms[i+1:]:
        assert Polygon(a['poly']).intersection(Polygon(b['poly'])).area<.01,(a['id'],b['id'])
for d in cad['doors']+cad['slides']:assert box(*d['rect']).intersection(WU).area<.01,d['name']
for w in windows:assert box(*w['rect']).intersection(WU).area<.01,w['name']
walking=unary_union([Polygon(r['poly']) for r in rooms if r.get('counted') is not False]+
                    [box(*d['rect']) for d in cad['doors']+cad['slides']])
assert isinstance(walking,Polygon),'appearance disconnected a room or threshold'
furniture_count=0
proposal=ROOT/'layout-proposal.json'
if proposal.exists():
    from shapely.affinity import rotate
    for f in json.loads(proposal.read_text())['furniture']:
        p=rotate(box(f['cx']-f['w']/2,f['cy']-f['d']/2,f['cx']+f['w']/2,f['cy']+f['d']/2),
                 f['rot'],origin=(f['cx'],f['cy']))
        rp=next(r for r in rooms if r['id']==f['room'])
        assert p.difference(Polygon(rp['poly'])).area<.1,f['id']
        assert p.intersection(WU).area<.1,f['id']
        furniture_count+=1

# Local facade enclosure test at real horizontal elevations.  A temporary back
# section across each BEDROOM is used only to isolate this facade for the test;
# it is never exported as a wall.  The interior free-space component must not
# reach any outside edge of the test domain.  This catches the previous 0.45 m
# end blocks, which passed room/wall footprint checks but leaked above the sill.
bay_sections=[]
for z in [.2,.44,.46,1.0,2.3,2.6,2.89]:
    blockers=[box(*w[:4]) for i,w in enumerate(walls) if z<heights.get('w'+str(i),2.9)]
    blockers += [Polygon(r['poly']) for r in rooms if r.get('kind')=='bay' and z<=r.get('elevation',.45)]
    for w in windows:
        if z<=w['sill'] or (not w.get('openAbove') and z>=w['head']):
            blockers.append(box(*w['rect']))
        elif w.get('display3d')=='simple-window':
            rr=w['rect'];path=w.get('glazingLine')
            if not path:
                path=([[rr[0],(rr[1]+rr[3])/2],[rr[2],(rr[1]+rr[3])/2]] if rr[2]-rr[0]>=rr[3]-rr[1]
                      else [[(rr[0]+rr[2])/2,rr[1]],[(rr[0]+rr[2])/2,rr[3]]])
            blockers.append(LineString(path).buffer(5,cap_style=2))
            for p,post in zip(path,w.get('endPosts',[True,True])):
                if post:blockers.append(box(p[0]-20,p[1]-20,p[0]+20,p[1]+20))
    for rid,domain,back_y,seed in [
        ('bayNorth',box(-300,-300,4200,1300),1000,Point(1800,900)),
        ('baySouth',box(-300,11900,4200,13500),12100,Point(1800,12200))]:
        closed=unary_union(blockers+[LineString([[0,back_y],[3700,back_y]]).buffer(5,cap_style=2)])
        free=domain.difference(closed)
        hits=[p for p in getattr(free,'geoms',[free]) if p.contains(seed)]
        assert len(hits)==1,(rid,z,'interior sample not in free space')
        leak=hits[0].intersection(domain.boundary).length>.01
        assert not leak,(rid,z,'interior facade open to outside')
        bay_sections.append({'bay':rid,'heightM':z,'openToOutside':False})

# Exposure is independent of enclosure: left return glass must actually face
# outdoors, rather than look straight into a tall wall or a large low end block.
left_return_rays=[]
for z in [.9,1.0,1.5,2.3]:
    opaque=[box(*w[:4]) for i,w in enumerate(walls) if z<heights.get('w'+str(i),2.9)]
    opaque += [box(*w['rect']) for w in windows if z<=w['sill'] or (not w.get('openAbove') and z>=w['head'])]
    obstruction=unary_union(opaque)
    for rid,x,y in [('bayNorth',650,300),('baySouth',660,12860)]:
        ray=LineString([[x,y],[x-1000,y]])
        blocked_length=ray.intersection(obstruction).length
        assert blocked_length<.01,(rid,z,'left glass obstructed by opaque construction',blocked_length)
        left_return_rays.append({'bay':rid,'heightM':z,'distanceMm':1000,'opaqueBlockedLengthMm':0})

exterior_empty=[]
solid_or_floor=unary_union([WU]+[Polygon(r['poly']) for r in rooms]+
                         [box(*w['rect']) for w in windows if w['sill']>0])
for rid,rr in [('bayNorth',[0,0,600,550]),('baySouth',[0,12605,610,13165])]:
    overlap=box(*rr).intersection(solid_or_floor).area
    assert overlap<.01,(rid,'outdoors filled by an end block or floor',overlap)
    exterior_empty.append({'bay':rid,'rect':rr,'solidOrFloorOverlapMm2':0})

# Every glass footprint (including both shared corners) has a supporting solid
# sill/base below it, not merely a line drawn across an empty floor region.
sill_support=unary_union([box(*w[:4]) for w in walls]+
    [box(*w['rect']) for w in windows if w['sill']>=.45]+
    [Polygon(r['poly']) for r in rooms if r.get('kind')=='bay'])
bay_sill_gap=0
for w in windows:
    if w.get('kind')=='u-bay':
        missing=LineString(w['glazingLine']).buffer(5,cap_style=2).difference(sill_support).area
        assert missing<.01,(w['name'],'unsupported sill/glass footprint',missing)
        bay_sill_gap+=missing
audit={'basis':'CAD dimensions with owner-photo appearance overrides','exactCadMatch':False,
       'bedroomBodiesUnchanged':True,'interiorDoorsUnchanged':True,'kitchenWindowSide':args.kitchen_window_side,
       'wallRectangleCount':len(walls),'windowsOrEdgeSegments':len(windows),
       'normalRoomWallOverlapMm2':0,'roomOverlapMm2':0,'doorWallOverlapMm2':0,'windowWallOverlapMm2':0,
       'walkableFloorConnected':True,'furnitureFootprintsVerified':furniture_count,
       'originalCadAuditPreservedSeparately':True,
       'wallHeightOverrideCount':len(heights),'bayRearSealsFullHeight':True,
       'bayEnclosureSections':bay_sections,'bayUnsupportedSillAreaMm2':round(bay_sill_gap,6),
       'leftReturnExteriorClearanceVerified':True,'leftReturnExteriorRays':left_return_rays,
       'bayExteriorEmptyRegions':exterior_empty}
result={'id':'home-2a-photo-appearance-v1','version':1,'units':'mm',
        'source':'assets/original-floorplan.jpg','sourceRole':'owner-original-photo-appearance',
        'referenceRole':'另户型图片仅辅助辨识非阳台构件，未使用其尺寸及阳台平面',
        'kitchenWindowSide':args.kitchen_window_side,
        'cadReference':{'source':cad['source'],'geometryAudit':cad['geometryAudit']},
        'overrides':{'walls':walls,'wallHeights':heights,'windows':windows,'rooms':rooms,
                     'reservedZones':reserved,'exteriorFeatures':[],
                     'annotations':[{'at':[5000,12300],'text':'设备平台外侧留空'}],
                     'geometryAudit':audit,'appearanceAudit':audit},
        'wallOrigins':wall_origins,'audit':audit,
        'changes':['两处飘窗向室外凸出三面玻璃，仅后端接墙带封闭；左玻璃外侧保持室外无遮挡，CAD主要窗跨度不变。',
                   '保留四卧内墙面、bodyRect/bodySize与所有内部门洞的CAD控制尺寸。',
                   '厨房仅采用业主最终确认的北墙窗；东墙连续实墙。' if args.kitchen_window_side=='north' else '厨房东窗为原照片比例选项，不与北窗同时使用。',
                   '南阳台东侧满高墙按自家原图改为细边沿；两阳台保留自家形态和外机条带。',
                   '南中卧外仅恢复原照片的浅设备平台，其余室外凹口保持留空。'],
        'assumptions':['这是照片外观覆盖层；原CAD源实体与审计保留为对照，不宣称全部外观与CAD一致。',
                       '飘窗左返的局部水平位置、平台宽深和设备低边沿按照片比例表达，需现场复尺。',
                       '仅层高2.9m与北向为业主给定；窗台、窗顶、栏杆及设备平台标高均为展示假定，仅飘窗后端连接带封闭至室内层高。',
                       '阳台边沿仅用简化栏框表达，不认定全高封窗、栏杆材料或实际竖向构造。',
                       '照片中的厨房西隔墙不采用，因为业主已确认厨餐开放且本户CAD无该墙。']}
(ROOT/'photo-appearance.js').write_text('/* Generated by scripts/build_photo_appearance.py; photo appearance, CAD dimensions. */\nwindow.PHOTO_APPEARANCE = '+json.dumps(result,ensure_ascii=False,separators=(',',':'))+';\n')
print(json.dumps(audit,ensure_ascii=False,indent=2))
