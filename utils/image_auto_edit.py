# imggen.py
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops, ImageOps
import os, random, unicodedata, re, glob as _glob
from datetime import datetime

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.dirname(_SCRIPT_DIR)


def _discover_fonts():
    """Auto-discover available font files from project dir, script dir, and system fonts."""
    found = []
    # 1) Project root and script dir — local .otf / .ttf files
    for search_dir in (_PROJECT_DIR, _SCRIPT_DIR):
        for ext in ("*.otf", "*.ttf"):
            found.extend(_glob.glob(os.path.join(search_dir, ext)))
    # 2) Windows system fonts (common handwriting / casual / fallback)
    win_fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    preferred = [
        "WildYouth.otf", "Wild Youth.otf",
        "segoesc.ttf", "segoepr.ttf", "comic.ttf",
        "arial.ttf",
    ]
    for name in preferred:
        p = os.path.join(win_fonts_dir, name)
        if os.path.isfile(p) and p not in found:
            found.append(p)
    # 3) Deduplicate while preserving order
    seen = set()
    result = []
    for p in found:
        norm = os.path.normcase(os.path.abspath(p))
        if norm not in seen:
            seen.add(norm)
            result.append(p)
    return result


# ---------- Defaults (können beim Aufruf überschrieben werden) ----------
DEFAULTS = {
    "TEMPLATE_PATH": "template.png",
    "BOX": (568, 500, 130, 190),             # x, y, w, h
    "FONT_PATHS": _discover_fonts(),
    "TEXT_X_OFFSET": 20,
    "LINE_ROTATE_DEG": -1.0,
    "JITTER_Y_PX": 2,
    "TRACKING_LINE1": 2,
    "TRACKING_LINE2": 0,
    "AUTO_SIZE_BY_LENGTH": True,
    "REF_COUNT": 10,
    "REF_SIZE": 20,
    "STEP_PT": 2,
    "MIN_SIZE": 10,
    "MAX_SIZE": 40,
    "FIXED_FONT_SIZE": None,
    "INK_RGB": (45, 45, 45),
    "INK_SOFT_BLUR_PX": 0.25,
    "TEXT_LAYER_BLUR_PX": 0.10,
    "ALPHA_MIN": 0.80,
    "ALPHA_MAX": 0.97,
    "ALPHA_SMOOTH_BLUR": 0.7,
    "ADD_GRAIN": True,
    "GRAIN_STRENGTH": 2,
    "GRAIN_ATTENUATION": 6,
    "ENABLE_SMOOTH_WARP": True,      # wird automatisch deaktiviert, wenn SciPy fehlt
    "SMOOTH_WARP_AMP": 1.4,
    "SMOOTH_WARP_SCALE": 50,
    "CROP_PAD": 60,
}

# ---------- interne Helpers ----------
def _load_font(size: int, font_paths) -> ImageFont.FreeTypeFont:
    for p in font_paths:
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size=size)
            except Exception:
                continue
    try:
        return ImageFont.load_default()
    except Exception:
        raise FileNotFoundError("Kein passender Font. Lege 'WildYouth.otf' ins Projekt oder passe FONT_PATHS an.")

def _count_letters(s: str) -> int:
    return sum(1 for ch in s if unicodedata.category(ch).startswith('L'))

def _auto_size_from_length(name_line: str, ref_count, ref_size, step_pt, min_size, max_size) -> int:
    n = _count_letters(name_line)
    size = ref_size + (ref_count - n) * step_pt
    return max(min_size, min(max_size, int(round(size))))

def _text_width_with_tracking(d: ImageDraw.ImageDraw, line: str, font, tracking_px: int) -> int:
    base_w = sum(d.textlength(ch, font=font) for ch in line)
    track_w = tracking_px * max(0, len(line) - 1)
    return int(base_w + track_w)

def _pick_font_for_first_line(draw, name_line: str, cfg) -> ImageFont.FreeTypeFont:
    size = _auto_size_from_length(name_line, cfg["REF_COUNT"], cfg["REF_SIZE"], cfg["STEP_PT"], cfg["MIN_SIZE"], cfg["MAX_SIZE"]) \
           if cfg["AUTO_SIZE_BY_LENGTH"] else (cfg["FIXED_FONT_SIZE"] or cfg["REF_SIZE"])
    f = _load_font(size, cfg["FONT_PATHS"])
    w = _text_width_with_tracking(draw, name_line, f, cfg["TRACKING_LINE1"])
    BOX_X, BOX_Y, BOX_W, BOX_H = cfg["BOX"]

    while (w > BOX_W * 0.95) and size > cfg["MIN_SIZE"]:
        size -= 1
        f = _load_font(size, cfg["FONT_PATHS"])
        w = _text_width_with_tracking(draw, name_line, f, cfg["TRACKING_LINE1"])
    return f

def _render_text_layer_with_tracking(canvas_size, text: str, font, cfg) -> Image.Image:
    W, H = canvas_size
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    lines = text.split("\n")

    BOX_X, BOX_Y, BOX_W, BOX_H = cfg["BOX"]
    total_h = sum(font.getbbox(l)[3] for l in lines) + (len(lines) - 1) * font.size * 0.3
    y = BOX_Y + (BOX_H - total_h) // 2

    for i, line in enumerate(lines):
        tracking = cfg["TRACKING_LINE1"] if i == 0 else cfg["TRACKING_LINE2"]
        base_w = sum(d.textlength(ch, font=font) for ch in line)
        track_w = tracking * max(0, len(line) - 1)
        w = int(base_w + track_w)
        x = BOX_X + (BOX_W - w) // 2 + cfg["TEXT_X_OFFSET"]
        jitter = random.randint(-cfg["JITTER_Y_PX"], cfg["JITTER_Y_PX"])

        for idx, ch in enumerate(line):
            d.text((x, y + jitter), ch, font=font, fill=(*cfg["INK_RGB"], 255))
            x += int(d.textlength(ch, font=font))
            if idx < len(line) - 1:
                x += tracking
        y += font.getbbox(line)[3] + font.size * 0.3

    layer = layer.rotate(
        cfg["LINE_ROTATE_DEG"],
        resample=Image.Resampling.BICUBIC,
        center=(BOX_X + BOX_W // 2, BOX_Y + BOX_H // 2),
        expand=False,
    )
    if cfg["TEXT_LAYER_BLUR_PX"] > 0:
        layer = layer.filter(ImageFilter.GaussianBlur(cfg["TEXT_LAYER_BLUR_PX"]))
    return layer

def _smooth_random_distortion(img: Image.Image, amp=1.8, scale=50) -> Image.Image:
    try:
        import numpy as np
        from scipy.ndimage import map_coordinates, gaussian_filter
    except Exception:
        return img  # SciPy/Numpy nicht vorhanden -> kein Warp

    w, h = img.size
    rng = np.random.default_rng()
    nx_small = rng.standard_normal((max(2, h // scale) + 3, max(2, w // scale) + 3))
    ny_small = rng.standard_normal((max(2, h // scale) + 3, max(2, w // scale) + 3))

    def upscale_and_smooth(a):
        a = np.kron(a, np.ones((scale, scale)))
        a = a[:h, :w]
        a = gaussian_filter(a, sigma=scale * 0.4)
        a -= a.min(); a /= (a.max() + 1e-8)
        return (a - 0.5)

    nx = upscale_and_smooth(nx_small)
    ny = upscale_and_smooth(ny_small)

    base = np.array(img)
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing='ij')
    dx = nx * amp
    dy = ny * amp

    out = np.empty_like(base)
    for c in range(base.shape[2]):
        out[..., c] = map_coordinates(base[..., c], [yy + dy, xx + dx],
                                      order=1, mode='reflect')
    return Image.fromarray(out, 'RGBA')

def _paper_aware_alpha(paper_gray: Image.Image, alpha: Image.Image,
                       min_opacity=0.80, max_opacity=0.97,
                       smooth_blur=0.7) -> Image.Image:
    strength = ImageOps.invert(paper_gray)
    if smooth_blur and smooth_blur > 0:
        strength = strength.filter(ImageFilter.GaussianBlur(smooth_blur))
    lo, hi = float(min_opacity), float(max_opacity)
    lut = [int(round(255.0 * (lo + (hi - lo) * (s / 255.0)))) for s in range(256)]
    F = strength.point(lut, mode="L")
    return ImageChops.multiply(alpha, F)

def _embed_text_into_paper(base_rgba: Image.Image, text_rgba: Image.Image, cfg) -> Image.Image:
    base = base_rgba.convert("RGBA")
    BOX_X, BOX_Y, BOX_W, BOX_H = cfg["BOX"]
    x0 = max(0, BOX_X - cfg["CROP_PAD"])
    y0 = max(0, BOX_Y - cfg["CROP_PAD"])
    x1 = min(base.width,  BOX_X + BOX_W + cfg["CROP_PAD"])
    y1 = min(base.height, BOX_Y + BOX_H + cfg["CROP_PAD"])

    paper_crop = base.crop((x0, y0, x1, y1)).convert("RGB")
    text_crop  = text_rgba.crop((x0, y0, x1, y1))

    _, _, _, a = text_crop.split()

    ink_color = Image.new("RGB", paper_crop.size, cfg["INK_RGB"])
    ink_rgb = Image.composite(ink_color, paper_crop, a)
    ink_on_paper = ImageChops.multiply(paper_crop, ink_rgb)

    if cfg["INK_SOFT_BLUR_PX"] > 0:
        ink_on_paper = ink_on_paper.filter(ImageFilter.GaussianBlur(cfg["INK_SOFT_BLUR_PX"]))

    paper_gray = paper_crop.convert("L").filter(ImageFilter.GaussianBlur(0.6))
    mod_alpha = _paper_aware_alpha(
        paper_gray, a,
        min_opacity=cfg["ALPHA_MIN"], max_opacity=cfg["ALPHA_MAX"],
        smooth_blur=cfg["ALPHA_SMOOTH_BLUR"]
    )

    if cfg["ADD_GRAIN"]:
        noise = Image.effect_noise(paper_crop.size, cfg["GRAIN_STRENGTH"])
        noise = noise.point(lambda x: x // cfg["GRAIN_ATTENUATION"])
        ink_on_paper = ImageChops.add(ink_on_paper, noise.convert("RGB"))

    ink_rgba = Image.merge("RGBA", (*ink_on_paper.split(), mod_alpha))
    result = base.copy()
    result.paste(ink_rgba, (x0, y0), mod_alpha)
    return result

# ---------- öffentliche API ----------
def generate_name_card(
    name: str,
    date_str: str | None = None,
    out_dir: str = "personalized",
    out_filename: str | None = None,
    **overrides
) -> str:
    """
    Erzeugt ein personalisiertes Bild (Name + optional Datum) und gibt den Pfad zur JPG-Datei zurück.
    'overrides' kann jedes Feld aus DEFAULTS überschreiben (z. B. TEMPLATE_PATH, BOX, FONT_PATHS, ...).
    """
    cfg = DEFAULTS.copy()
    cfg.update(overrides or {})
    os.makedirs(out_dir, exist_ok=True)

    # Name sanitizen (nur druckbare Unicode-Buchstaben, Leerzeichen, - . ' und \n)
    name = re.sub(r"[^\w ÄÖÜäöüß\-\.\'\n]", "", name, flags=re.UNICODE).strip()
    # Doppelte/zu viele Zeilen entfernen
    lines = [ln.strip() for ln in name.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("Leerer Name.")
    first_line = lines[0]

    # zweite Zeile: Datum?
    if date_str:
        text = f"{first_line}\n{date_str}"
    else:
        text = first_line

    base = Image.open(cfg["TEMPLATE_PATH"]).convert("RGBA")
    draw_for_fit = ImageDraw.Draw(base)

    font = _pick_font_for_first_line(draw_for_fit, first_line, cfg)
    text_layer = _render_text_layer_with_tracking(base.size, text, font, cfg)

    # Warp optional
    enable_warp = cfg["ENABLE_SMOOTH_WARP"]
    if enable_warp:
        text_layer = _smooth_random_distortion(text_layer,
                                               amp=cfg["SMOOTH_WARP_AMP"],
                                               scale=cfg["SMOOTH_WARP_SCALE"])

    final_rgba = _embed_text_into_paper(base, text_layer, cfg)
    if not out_filename:
        out_filename = "output.jpg"
    out_path = os.path.join(out_dir, out_filename)
    final_rgba.convert("RGB").save(out_path, quality=95)
    return out_path

if __name__ == "__main__":
    # Mini-Test
    today = datetime.now().strftime("%-d.%-m.%y") if os.name != "nt" else datetime.now().strftime("%#d.%#m.%y")
    p = generate_name_card("Moritz", today, out_dir="personalized_test")
    print("Gespeichert:", p)
