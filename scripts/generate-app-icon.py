"""Regenerate the checked-in, code-native pixel workspace mark (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

target = Path(__file__).resolve().parents[1] / "apps/desktop/assets"
target.mkdir(parents=True, exist_ok=True)
# All geometry uses a 64-unit grid; the stacked cards stand for a shared workspace.
shapes = [
    ("polygon", [(12,4),(52,4),(52,8),(60,8),(60,56),(56,56),(56,60),(8,60),(8,56),(4,56),(4,12),(8,12),(8,8),(12,8)], "#111111"),
    ("rectangle", (18,14,48,18), "#ffffff"),
    ("rectangle", (14,22,50,50), "#ffffff"),
    ("polygon", [(21,34),(27,40),(41,26),(45,30),(27,48),(17,38)], "#111111"),
]
image = Image.new("RGBA", (1024,1024))
draw = ImageDraw.Draw(image)
svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">']
for kind, points, fill in shapes:
    if kind == "polygon":
        draw.polygon([(x*16,y*16) for x,y in points], fill=fill)
        svg.append('<polygon points="'+' '.join(f'{x},{y}' for x,y in points)+f'" fill="{fill}"/>')
    else:
        x1,y1,x2,y2 = points
        draw.rectangle((x1*16,y1*16,x2*16-1,y2*16-1), fill=fill)
        svg.append(f'<rect x="{x1}" y="{y1}" width="{x2-x1}" height="{y2-y1}" fill="{fill}"/>')
svg.append('</svg>')
(target / "workspace.svg").write_text('\n'.join(svg),encoding="utf-8")
image.resize((256,256),Image.Resampling.LANCZOS).save(target / "workspace.png")
image.save(target / "workspace.ico", sizes=[(n,n) for n in [16,20,24,32,40,48,64,128,256]])
