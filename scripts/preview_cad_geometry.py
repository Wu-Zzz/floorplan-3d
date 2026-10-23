"""Render generated geometry beside the unmodified CAD source for visual QA."""
from pathlib import Path
import json, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, Rectangle, Circle, Arc
from matplotlib.font_manager import FontProperties

ROOT=Path(__file__).resolve().parents[1]
text=(ROOT/'cad-geometry.js').read_text()
d=json.loads(text[text.index('=')+1:].strip().rstrip(';'))
font=FontProperties(fname='/System/Library/Fonts/Hiragino Sans GB.ttc')
fig,axes=plt.subplots(1,2,figsize=(16,11.5),layout='constrained')
for ax,title in zip(axes,['CAD 原始实体（未修线）','网页几何 + CAD 叠加核对']):
    ax.set_aspect('equal');ax.set_xlim(-700,12750);ax.set_ylim(13900,-700)
    ax.set_title(title,fontproperties=font,fontsize=14);ax.axis('off')

def source(ax,alpha=1,lw=.8):
    for s in d['sourceLines']:
        ax.plot([s['start'][0],s['end'][0]],[s['start'][1],s['end'][1]],color='#0087ac' if s.get('color')==4 else '#bd3831',alpha=alpha,lw=lw,zorder=8)
    for s in d['sourceCircles']:
        ax.add_patch(Circle(s['center'],s['radius'],fill=False,ec='#bd3831',alpha=alpha,lw=lw,zorder=8))
    for s in d['sourceArcs']:
        # The normalized y coordinate is inverted, so sample the original CAD arc.
        delta=(-s['endAngle']+s['startAngle'])%360
        aa=[-s['startAngle']+delta*i/60 for i in range(61)]
        ax.plot([s['center'][0]+s['radius']*math.cos(math.radians(a)) for a in aa],
                [s['center'][1]-s['radius']*math.sin(math.radians(a)) for a in aa],color='#bd3831',alpha=alpha,lw=lw,zorder=8)
    for s in d['sourcePolylines']:
        pp=s['points']+[s['points'][0]] if s['closed'] else s['points']
        ax.plot([p[0] for p in pp],[p[1] for p in pp],color='#bd3831',alpha=alpha,lw=lw,zorder=8)
source(axes[0])
ax=axes[1]
colors={'wood':'#ecdfc6','antislip':'#d2e5df','tile600':'#dae4ec','tile800':'#f2efe7','marble':'#e5e1eb'}
for r in d['rooms']:
    ax.add_patch(Polygon(r['poly'],fc=colors[r['mat']],ec='#bbb7ae',lw=.4))
    if r.get('at'):
        label=r['name']
        if r.get('bodySize'): label+='\n'+' × '.join(str(n) for n in r['bodySize'])
        ax.text(*r['at'],label,ha='center',va='center',fontproperties=font,fontsize=8,zorder=10)
for w in d['walls']:
    ax.add_patch(Rectangle((w[0],w[1]),w[2]-w[0],w[3]-w[1],fc='#313638' if w[4]!='low' else '#929a9a',ec='none',zorder=4))
for w in d['windows']:
    a,b,c,e=w['rect'];ax.add_patch(Rectangle((a,b),c-a,e-b,fc='#a6d7ed',alpha=.7,zorder=5))
for item in d['doors']+d['slides']:
    a,b,c,e=item['rect'];ax.add_patch(Rectangle((a,b),c-a,e-b,fc='#f1f2ec',ec='#758a78',lw=.4,zorder=5))
for r in d['reservedZones']:
    ax.add_patch(Polygon(r['poly'],fill=False,ec='#75878d',hatch='///',lw=.6,zorder=6))
ax.text(5000,12100,'室外凹口\n保持留空',ha='center',fontproperties=font,fontsize=9,color='#666')
source(ax,.6,.45)
out=Path('/tmp/cad-geometry-qa.png')
fig.savefig(out,dpi=180,facecolor='white')
print(out)
