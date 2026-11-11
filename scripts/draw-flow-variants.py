#!/usr/bin/env python3
"""Generate four editable pencil-style flow layouts, using only the stdlib."""
from html import escape
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "docs" / "diagram-variants"
OUT.mkdir(parents=True, exist_ok=True)

DEFS = '''<defs>
  <filter id="paper"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" seed="9" result="noise"/><feColorMatrix in="noise" type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".03"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter>
  <filter id="pencil" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="2" seed="17" result="grain"/><feDisplacementMap in="SourceGraphic" in2="grain" scale=".8" xChannelSelector="R" yChannelSelector="G"/></filter>
  <marker id="arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto"><path d="M2 2 L10 6 L2 10" fill="none" stroke="#535b51" stroke-width="1.6" stroke-linejoin="round"/></marker>
  <style>
    text { font-family:'Chalkboard SE','Comic Sans MS',cursive; fill:#394239; text-anchor:middle; }
    .route { fill:none; stroke:#535b51; stroke-width:2.2; stroke-linejoin:round; stroke-linecap:round; marker-end:url(#arrow); }
    .note { fill:none; stroke:#7b8e95; stroke-width:1.8; stroke-dasharray:6 5; stroke-linejoin:round; }
    .echo { fill:none; stroke:#868b7c; stroke-width:.7; opacity:.4; }
  </style>
</defs>'''


class Drawing:
    def __init__(self, title, subtitle):
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800" viewBox="0 0 1400 800" role="img" aria-label="{escape(title, quote=True)}">', DEFS,
                      '<rect width="1400" height="800" fill="#faf8f0" filter="url(#paper)"/>', '<g filter="url(#pencil)">']
        self.text(45, 56, title, 31, anchor="start")
        self.text(45, 96, subtitle, 21, anchor="start", color="#6a7468")

    def text(self, x, y, value, size=23, anchor="middle", color="#394239"):
        self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" style="text-anchor:{anchor};fill:{color}">{escape(value)}</text>')

    def path(self, d, cls="route"):
        self.parts.append(f'<path d="{d}" class="{cls}"/>')

    def panel(self, x, y, w, h, fill="#f3f2e8", dashed=False):
        dash = ' stroke-dasharray="6 5"' if dashed else ''
        self.parts.append(f'<path d="M{x} {y} Q{x+w/2} {y-2} {x+w} {y+1} L{x+w+1} {y+h} Q{x+w/2} {y+h+2} {x-1} {y+h-1} Z" fill="{fill}" stroke="#6e796b" stroke-width="1.7"{dash}/>')
        self.path(f'M{x-2} {y-2} L{x+w+2} {y-1} L{x+w+3} {y+h+2} L{x-2} {y+h+2}', "echo")

    def box(self, x, y, w, h, tag, title, lines=(), fill="#fbfaf4", size=26):
        self.panel(x, y, w, h, fill)
        self.text(x+w/2, y+27, tag, 16, color="#758071")
        self.text(x+w/2, y+64, title, size)
        for i, line in enumerate(lines):
            self.text(x+w/2, y+94+i*25, line, 18, color="#667260")

    def footer(self):
        self.path('M45 730 Q690 727 1355 730', 'echo')
        self.text(700, 757, 'Astra: Plan only  ·  Free models if sufficient  ·  Terra/Sol for more judgment  ·  Cache the chosen route', 18)
        self.text(700, 784, 'Existing OpenAI sign-in or keyless free models. Jev is a separate classifier service.', 16, color="#7a8174")

    def save(self, filename):
        self.parts += ['</g>', '</svg>']
        (OUT / filename).write_text('\n'.join(self.parts) + '\n')


def journey():
    d = Drawing('A · One straight journey', 'Read left to right: select once, plan, route once, then keep building.')
    for x1, x2 in [(275, 325), (545, 595), (815, 865), (1095, 1145)]:
        d.path(f'M{x1} 275 L{x2} 275')
    d.box(45, 205, 230, 140, 'SELECT', 'smartrouter - openai', ['One entry in /models'], size=22)
    d.box(325, 205, 220, 140, 'PLAN', 'Astra', ['Existing OpenAI sign-in'], fill='#f0eedf')
    d.box(595, 205, 220, 140, 'FIRST BUILD PROMPT', 'Jev · one call', ['Choose + confidence'], fill='#eaf1f1')
    d.box(865, 205, 230, 140, 'BUILD', 'Chosen model', ['Free OR Terra / Sol', 'Picker shows real model'], fill='#eef2e8')
    d.box(1145, 205, 210, 140, 'LATER BUILD TURNS', 'Reuse choice', ['No new Jev call'])
    d.path('M705 345 L705 415')
    d.panel(325, 415, 770, 205, '#f5f7f0')
    d.text(365, 454, 'CHOICE 1', 17, anchor='start', color='#6c7f83')
    d.text(365, 497, 'Free or OpenAI?', 27, anchor='start')
    d.text(365, 533, 'Family + confidence', 20, anchor='start')
    d.path('M663 444 L663 589', 'echo')
    d.text(700, 454, 'CHOICE 2', 17, anchor='start', color='#6c7f83')
    d.text(700, 497, 'Free: GLM / other free models', 23, anchor='start')
    d.text(700, 537, 'OpenAI: Terra or Sol', 23, anchor='start')
    d.text(700, 575, 'Model + confidence', 20, anchor='start')
    d.path('M705 345 L705 380 L160 380 L160 445', 'note')
    d.box(45, 445, 230, 140, 'BELOW 0.80 CONFIDENCE', 'Ask approval', ['Before Build executes'], fill='#f0f2ef', size=24)
    d.text(700, 680, 'The Jev notice prints both choices. Infra / security guards can require Terra or Sol.', 21)
    d.footer(); d.save('01-journey.svg')


def tree():
    d = Drawing('B · The decision tree', 'Start in Plan. Only branch when the first Build instruction arrives.')
    d.box(500, 125, 400, 115, 'smartrouter - openai · PLAN', 'Astra plans', ['Your existing OpenAI sign-in'], fill='#f0eedf')
    d.path('M700 240 L700 268')
    d.panel(520, 273, 360, 45, '#f7f6ed')
    d.text(700, 302, 'Switch to Build + send instruction', 21)
    d.path('M700 320 L700 345')
    d.parts.append('<path d="M700 350 L850 425 L700 500 L550 425 Z" fill="#eaf1f1" stroke="#6e796b" stroke-width="1.9"/>')
    d.text(700, 417, 'Jev chooses', 28)
    d.text(700, 451, 'one classifier call', 19)
    d.path('M550 425 L385 425 L385 545')
    d.path('M850 425 L1015 425 L1015 545')
    d.text(360, 510, 'FREE SUFFICIENT', 17, anchor='end', color='#6e7e6b')
    d.text(1040, 510, 'OPENAI NEEDED', 17, anchor='start', color='#6e7e6b')
    d.box(200, 550, 370, 115, 'BUILD · FREE', 'GLM / other free model', ['Jev picks the eligible free model'], fill='#eef2e8', size=25)
    d.box(830, 550, 370, 115, 'BUILD · OPENAI', 'Terra or Sol', ['Jev also chooses which one'], fill='#eef2e8')
    d.path('M385 665 L385 689 L700 689 L700 710')
    d.path('M1015 665 L1015 689 L700 689 L700 710')
    d.text(700, 723, 'Use the native model → cache for later Build turns', 23)
    d.panel(1015, 310, 315, 80, '#f0f2ef', dashed=True)
    d.text(1172, 342, 'Confidence below 0.80?', 22)
    d.text(1172, 373, 'Ask you before execution.', 20)
    d.path('M850 425 L941 425 L941 350 L1015 350', 'note')
    d.text(700, 776, 'Astra never builds. Risk guards may require a stronger route. The picker shows the chosen model.', 18)
    d.save('02-decision-tree.svg')


def swimlane():
    d = Drawing('C · Who does what', 'Each row is one moment in the session. Follow the arrows across.')
    for x, w, title, fill in [(30, 420, 'YOU', '#f2f1e7'), (480, 420, 'SMART ROUTER', '#eef2e9'), (930, 440, 'NATIVE MODELS', '#eaf0f0')]:
        d.panel(x, 130, w, 575, fill)
        d.text(x+w/2, 161, title, 19, color='#6b7667')
    d.path('M415 235 L515 235'); d.path('M865 235 L965 235')
    d.path('M415 425 L515 425'); d.path('M865 425 L965 425')
    d.path('M415 615 L515 615'); d.path('M865 615 L965 615')
    d.path('M1150 290 L1150 327 L690 327 L690 370')
    d.text(942, 316, 'finished plan', 17, color='#6e7b72')
    d.box(65, 180, 350, 110, 'PLAN', 'Select smartrouter - openai', ['Send your planning request'], size=22)
    d.box(515, 180, 350, 110, 'PLAN ROUTE', 'Native OpenAI alias', ['Use the existing sign-in'], fill='#f5f5ed', size=25)
    d.box(965, 180, 370, 110, 'PLAN MODEL', 'Astra', ['Produces the finished plan'], fill='#f0eedf')
    d.box(65, 370, 350, 110, 'BUILD', 'Switch + send instruction', ['The toggle alone does not call Jev'], size=23)
    d.box(515, 370, 350, 110, 'JEV · ONCE', 'Choose sufficient model', ['Below 0.80 → ask approval'], fill='#eaf1f1', size=24)
    d.box(965, 370, 370, 110, 'BUILD MODEL', 'Free OR Terra / Sol', ['Never Astra; picker updates'], fill='#eef2e8', size=25)
    d.box(65, 560, 350, 110, 'CONTINUE', 'Next Build instruction', ['Normal edits, tools, and follow-ups'], size=24)
    d.box(515, 560, 350, 110, 'CACHE', 'Reuse the chosen route', ['No additional Jev classification'], size=24)
    d.box(965, 560, 370, 110, 'SAME BUILD MODEL', 'Keep building', ['Its native provider handles requests'], fill='#eef2e8')
    d.footer(); d.save('03-swimlane.svg')


def storyboard():
    d = Drawing('D · Two modes, two jobs', 'Astra makes the plan. The model Jev chooses does the implementation.')
    d.panel(45, 145, 420, 485, '#f3f0e3')
    d.panel(510, 145, 845, 485, '#edf2ed')
    d.text(255, 190, '1 · PLAN', 27)
    d.text(932, 190, '2 · BUILD', 27)
    d.text(255, 235, 'Select smartrouter - openai', 22)
    d.text(932, 226, 'Switch mode + send the first Build instruction', 20)
    d.box(100, 285, 310, 140, 'PLANNER', 'Astra', ['Your existing OpenAI sign-in'], fill='#faf8ec', size=32)
    d.text(255, 530, 'Astra only plans.', 27)
    d.text(255, 568, 'It never executes Build.', 22)
    d.path('M410 355 L555 355')
    d.box(555, 285, 230, 140, 'CLASSIFIER', 'Jev · once', ['Family + model choices', 'Both confidences shown'], fill='#eaf1f1', size=27)
    d.path('M785 355 L840 355')
    d.panel(840, 270, 460, 165, '#f8faf1')
    d.text(1070, 302, 'JEV CHOOSES THE BUILD ROUTE', 17, color='#6a7b70')
    d.text(1070, 349, 'Free · GLM / other free models', 25)
    d.text(1070, 395, 'OpenAI · Terra or Sol', 25)
    d.path('M1070 435 L1070 490')
    d.box(840, 495, 460, 115, 'EXECUTE + REUSE', 'Chosen native model', ['Picker updates · session cache reuses choice'], fill='#f8faf1', size=27)
    d.path('M670 425 L670 475', 'note')
    d.box(555, 480, 230, 130, 'BELOW 0.80', 'Approve first', ['Before Build executes'], fill='#f0f2ef', size=24)
    d.text(700, 685, 'Infra / security guards may require Sol. Low-confidence choices never auto-execute.', 21)
    d.footer(); d.save('04-storyboard.svg')


for draw in (journey, tree, swimlane, storyboard):
    draw()
files = ['01-journey.svg', '02-decision-tree.svg', '03-swimlane.svg', '04-storyboard.svg']
if (OUT / '05-user-sketch.svg').exists():
    files.insert(0, '05-user-sketch.svg')
(OUT / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Smart Router flow variants</title>'
    '<style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#eeeae0;display:grid;grid-template-columns:1fr 1fr;gap:16px}img{display:block;width:100%;height:auto}'
    + ('a:first-child{grid-column:1/-1}' if len(files) > 4 else '') + '</style>'
    + ''.join(f'<a href="{name}" target="_blank"><img src="{name}" alt="Pencil flow option"></a>' for name in files))
print(f'Wrote 4 SVG variants to {OUT}')
