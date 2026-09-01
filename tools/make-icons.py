#!/usr/bin/env python3
"""Screenwall-Appicon erzeugen: dunkle Kachel, blauer Screen mit Play-Dreieck,
rechts zwei kleinere Wand-Panels (ruhend + On-Air-Rot). Die Farben sind die
Design-Tokens aus public/css/base.css.

    python3 tools/make-icons.py        # -> public/icons/* und public/favicon.ico

Die Geometrie ist identisch zu public/favicon.svg (dem Vektor-Favicon); wird sie
hier geaendert, bitte dort nachziehen. Benoetigt Pillow (pip install pillow).
"""
from PIL import Image, ImageDraw
import sys, os

SS = 8  # Supersampling: erst gross zeichnen, dann scharf herunterskalieren


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(size, top, bottom):
    """Senkrechter Farbverlauf in der gewuenschten Groesse."""
    w, h = size
    img = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.point((0, y), fill=lerp(top, bottom, y / max(1, h - 1)))
    return img.resize((w, h), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def paste_grad(dst, box, radius, top, bottom):
    """Abgerundetes Rechteck mit Verlauf in dst einsetzen."""
    x0, y0, x1, y1 = box
    size = (int(round(x1 - x0)), int(round(y1 - y0)))
    if size[0] < 1 or size[1] < 1:
        return
    dst.paste(vgrad(size, top, bottom), (int(round(x0)), int(round(y0))),
              rounded_mask(size, int(round(radius))))


def draw_icon(px, pad_frac=0.0):
    """pad_frac: zusaetzlicher Rand (Safe-Zone) fuer maskable Icons."""
    S = px * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Kachel: dunkler Hintergrund mit leichtem Verlauf (--bg / --panel)
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    paste_grad(tile, (0, 0, S, S), S * 0.22, (0x23, 0x2a, 0x3a), (0x0d, 0x0f, 0x14))
    img.alpha_composite(tile)

    inner = 1.0 - 2 * pad_frac
    W = 0.70 * S * inner       # Breite der "Wand"
    H = W * 0.58               # Hoehe der "Wand"
    cx, cy = S / 2, S / 2
    x0, y0 = cx - W / 2, cy - H / 2
    g = W * 0.055              # Fuge zwischen den Panels
    r = W * 0.075              # Panel-Radius

    screen_w = W * 0.655
    side_w = W - screen_w - g
    side_h = (H - g) / 2

    # Grosser Screen (--accent) mit Play-Dreieck
    paste_grad(img, (x0, y0, x0 + screen_w, y0 + H), r, (0x63, 0x9b, 0xff), (0x2b, 0x62, 0xd8))
    sc_cx, sc_cy = x0 + screen_w / 2, cy
    ph = H * 0.46
    pw = ph * 0.86
    tri = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(tri).polygon(
        [(sc_cx - pw * 0.42, sc_cy - ph / 2),
         (sc_cx - pw * 0.42, sc_cy + ph / 2),
         (sc_cx + pw * 0.58, sc_cy)],
        fill=(0xff, 0xff, 0xff, 0xff))
    img.alpha_composite(tri)

    # Rechte Spalte: oben ruhendes Panel, unten On Air (--live)
    sx = x0 + screen_w + g
    paste_grad(img, (sx, y0, sx + side_w, y0 + side_h), r, (0x49, 0x51, 0x63), (0x33, 0x39, 0x48))
    paste_grad(img, (sx, y0 + side_h + g, sx + side_w, y0 + H), r, (0xf2, 0x3b, 0x40), (0xd4, 0x14, 0x1a))

    return img.resize((px, px), Image.LANCZOS)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "public", "icons")
ICO = os.path.join(os.path.dirname(OUT), "favicon.ico")
os.makedirs(OUT, exist_ok=True)

for px in (192, 512):
    draw_icon(px).save(os.path.join(OUT, f"icon-{px}.png"))

# Maskable: Motiv innerhalb der Safe-Zone, Android beschneidet die Kachel
draw_icon(512, pad_frac=0.10).save(os.path.join(OUT, "icon-512-maskable.png"))

# Apple-Touch-Icon: ohne Transparenz, iOS rundet selbst ab
apple = Image.new("RGB", (180, 180), (0x11, 0x14, 0x1a))
apple.paste(draw_icon(180).convert("RGB"), (0, 0))
apple.save(os.path.join(OUT, "apple-touch-icon.png"))

# Favicon: mehrere Groessen in einer .ico
draw_icon(256).save(ICO, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

print("geschrieben:", OUT, "+", ICO)
